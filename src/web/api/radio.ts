/**
 * Radio Browser endpoints for the /radio page.
 *
 * These are read-only directory queries plus a live "now playing" probe. They
 * deliberately do NOT play anything: playback goes through the normal
 * /api/player/:botId/play-song path so radio stations share the one queue and
 * player with every other source.
 */

import express, { type Request, type Response } from "express";
import type { MusicProvider } from "../../music/provider.js";
import {
  RadioProvider,
  isImportableStreamUrl,
  isPlayableStreamUrl,
  mapStationToSong,
  type RadioSearchQuery,
  type RadioStation,
} from "../../music/radio.js";
import {
  parseM3u,
  type LocalRadioStore,
  type ParsedStation,
} from "../../music/radio-local.js";
import { fetchStreamMetadata } from "../../music/radio-metadata.js";
import { isProviderEnabled, type BotConfig } from "../../data/config.js";
import { authorize } from "../middleware/authorize.js";
import { requireNotGuest } from "../middleware/requireNotGuest.js";
import type { Song } from "../../music/provider.js";
import type { Logger } from "../../logger.js";

/** Playlists are pasted as text; 400kb matches the global JSON body limit, so a
 *  large M3U is rejected by the same guard as any oversized request. */
const MAX_IMPORT_STATIONS = 500;

export interface RadioRouterOptions {
  /** Operator-imported station storage. Omitted in tests that only exercise
   *  directory endpoints. */
  localStore?: LocalRadioStore;
  /** `fetch` injection for the reachability probe (tests never touch a network). */
  fetchImpl?: typeof fetch;
}

/** How long a resolved ICY title is reused. Stations re-send the same block
 *  every few seconds; polling them for every browser would be abusive. */
const NOW_PLAYING_TTL_MS = 15_000;

/** Per-station reachability result reuse. A page load checks every visible
 *  station, so without this a single user scrolling would dial each stream
 *  dozens of times. */
const STATION_STATUS_TTL_MS = 60_000;
/** One stream that hangs must not stall the whole batch. */
const STATION_PROBE_TIMEOUT_MS = 6_000;
/** Cap per request: a batch of 40 is ~40 sockets if the page asks for a large
 *  limit, which is already generous. */
const MAX_STATUS_BATCH = 60;
const STATION_PROBE_UA = "TSMusicBot-radio-probe/0.1";

export type StationStatus = "online" | "offline" | "unknown";

export interface StationStatusResponse {
  id: string;
  url: string;
  /** True only when the stream answered 2xx and sent audio. */
  online: boolean;
  /** `unknown` is deliberately distinct from offline: a timeout or an
   *  unreachable probe must not present a station as dead. */
  state: StationStatus;
  httpStatus: number | null;
  latencyMs: number | null;
  checkedAt: string;
  /** True when the directory (not the probe) was the source of this answer. */
  fromDirectory: boolean;
}

/** Probe concurrency. A page holds ~50 stations; dialling them all at once
 *  would open ~50 sockets against stream servers and the directory. */
const MAX_PARALLEL_PROBES = 6;

function emptyStatus(url: string): StationStatusResponse {
  return {
    id: "",
    url,
    online: false,
    state: "unknown",
    httpStatus: null,
    latencyMs: null,
    checkedAt: new Date().toISOString(),
    fromDirectory: false,
  };
}

/** Run `fn` over `items` with at most `limit` in flight, preserving order. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

interface CacheEntry {
  at: number;
  value: NowPlayingResponse;
}

export interface NowPlayingResponse {
  stationId: string;
  /** Track title as reported by the stream, or the station name when the
   *  stream carries no ICY metadata. */
  title: string;
  artist: string;
  song: string;
  /** True when the values above came from ICY rather than the station name. */
  fromStream: boolean;
  fetchedAt: string;
}

export function createRadioRouter(
  provider: MusicProvider,
  logger: Logger,
  config: BotConfig,
  options: RadioRouterOptions = {},
): express.Router {
  const router = express.Router();
  const radio = provider instanceof RadioProvider ? provider : null;
  const localStore = options.localStore ?? null;
  const cache = new Map<string, CacheEntry>();
  const statusCache = new Map<string, { at: number; value: StationStatusResponse }>();
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  function unavailable(res: Response): void {
    res.status(503).json({ error: "Radio provider is not available" });
  }

  /**
   * Gate for the /local import + delete routes.
   *
   * Imported stations are operator-owned data (they live in
   * data/local-radio.json, survive restarts and are shared by every user), and
   * an import chooses an address the *server* will connect to. That is a
   * bot.manage concern, same as saving settings — not something a member, let
   * alone a guest, should be able to change. `authorize` without a guestFlag
   * denies guests outright and requires the capability for members.
   */
  const requireStationAdmin = authorize({ capability: "bot.manage" });

  /** Gate every route on the enabledProviders switch, mirroring the other
   *  opt-in sources (Jellyfin). An admin turns radio on in Settings → 音乐平台. */
  function requireRadio(res: Response): boolean {
    if (!radio) {
      unavailable(res);
      return false;
    }
    if (!isProviderEnabled(config, "radio")) {
      res.status(403).json({
        error: "电台音源未启用（radio disabled — 需在设置中开启）",
      });
      return false;
    }
    return true;
  }

  /** Directory rows carry a bit more than the generic Song; the card shows a
   *  "country · codec · bitrate" line. Kept as extra response fields rather
   *  than widening `Song`, which every provider shares. */
  function stationSong(s: RadioStation): Song & { codec: string; bitrate: number } {
    return { ...mapStationToSong(s), codec: s.codec, bitrate: s.bitrate };
  }

  /** The pinned strip's rows.
   *
   *  A favorite is a flag on the same station file 我的电台 reads, so one
   *  projection serves both: `local` marks a real import (the card shows the
   *  本地 chip), and `favorite` is always true here because that is what
   *  selected the row. Order comes from the store (newest star first). */
  function favoriteSongs(): Array<
    Song & { group: string; local: boolean; favorite: true; codec: string; bitrate: number }
  > {
    return (localStore?.favorites() ?? []).map((s) => ({
      ...mapStationToSong(s),
      group: s.group,
      local: s.imported !== false,
      favorite: true as const,
      codec: s.codec,
      bitrate: s.bitrate,
    }));
  }

  function toQuery(req: Request): RadioSearchQuery {
    const raw = req.query;
    const str = (k: string): string | undefined => {
      const v = raw[k];
      return typeof v === "string" && v.trim() ? v.trim() : undefined;
    };
    const num = (k: string): number | undefined => {
      const v = str(k);
      if (!v) return undefined;
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };
    const tags = str("tags");
    return {
      name: str("q") ?? str("name"),
      country: str("country"),
      language: str("language"),
      tags: tags ? tags.split(",").map((t) => t.trim()).filter(Boolean) : undefined,
      codec: str("codec"),
      bitrateMin: num("bitrateMin"),
      order: str("order") ?? "votes",
      reverse: str("reverse") !== "false",
      hideBroken: str("hideBroken") !== "false",
      limit: Math.min(Math.max(num("limit") ?? 40, 1), 100),
      offset: Math.max(num("offset") ?? 0, 0),
    };
  }

  // ─── Listing / search ───────────────────────────────────────────────────

  router.get("/stations", async (req, res) => {
    if (!requireRadio(res)) return;
    try {
      const query = toQuery(req);
      // A bare "browse" (no criteria) lists top stations instead of returning
      // empty, which is what the page shows before the user types anything.
      const stations =
        query.name || query.country || query.language || query.tags?.length || query.codec || query.bitrateMin
          ? await radio!.searchStations(query)
          : await radio!.topStations(query.limit ?? 40);
      res.json({ stations: stations.map(stationSong) });
    } catch (err) {
      logger.error({ err }, "Radio station listing failed");
      res.status(502).json({ error: (err as Error).message });
    }
  });

  router.get("/facets", async (_req, res) => {
    if (!requireRadio(res)) return;
    try {
      res.json(await radio!.getFacets());
    } catch (err) {
      logger.error({ err }, "Radio facets failed");
      res.status(502).json({ error: (err as Error).message });
    }
  });

  // ─── Locally imported stations ──────────────────────────────────────────
  //
  // These live under /local so they can never collide with the directory's
  // /stations/:id lookup. Reading the list is fine for anyone who can see the
  // page; every mutation is admin-only (bot.manage), because an import is
  // operator-owned data that also lets whoever writes it choose an address the
  // *server* will connect to.

  router.get("/local", (_req, res) => {
    if (!requireRadio(res)) return;
    if (!localStore) {
      res.json({ stations: [], groups: [] });
      return;
    }
    // Only imports: a starred directory station is stored in the same file so
    // the favorite survives an outage, but it has no import metadata and
    // belongs to the pinned 收藏 section instead of 我的电台.
    const stations = localStore.imports();
    res.json({
      stations: stations.map((s) => ({
        ...mapStationToSong(s),
        group: s.group,
        local: true,
        favorite: s.favorite === true,
      })),
      groups: localStore.groups(),
    });
  });

  /** Import a playlist or a single URL.
   *
   *  Body: `{ playlist?: string, url?: string, name?: string, group?: string }`.
   *  `playlist` is raw M3U text; `url` is a one-off addition. Supplying both
   *  imports the URL after the playlist, which is what the UI's "add by URL"
   *  box does while a pasted playlist is still in the textarea.
   *
   *  `dryRun: true` parses and reports without writing, so the UI can preview
   *  what an import will do (and what it will skip) before committing. */
  router.post("/local/import", requireStationAdmin, (req, res) => {
    if (!requireRadio(res)) return;
    if (!localStore) {
      unavailable(res);
      return;
    }

    const body = (req.body ?? {}) as {
      playlist?: unknown;
      url?: unknown;
      name?: unknown;
      group?: unknown;
      cover?: unknown;
      dryRun?: unknown;
    };
    const playlist = typeof body.playlist === "string" ? body.playlist : "";
    const singleUrl = typeof body.url === "string" ? body.url.trim() : "";
    const group = typeof body.group === "string" && body.group.trim()
      ? body.group.trim()
      : undefined;
    const cover = typeof body.cover === "string" && body.cover.trim()
      ? body.cover.trim()
      : undefined;
    // Only http(s) artwork is accepted: the value becomes an <img src> and a
    // javascript:/data: URL there would be a script-injection vector.
    if (cover && !/^https?:\/\//i.test(cover)) {
      res.status(400).json({ error: "cover 必须是 http(s) 图片地址" });
      return;
    }
    const dryRun = body.dryRun === true;

    if (!playlist.trim() && !singleUrl) {
      res.status(400).json({ error: "需要 playlist 或 url" });
      return;
    }

    const parsed = playlist.trim() ? parseM3u(playlist) : { stations: [], skipped: [] };
    const parsedStations: ParsedStation[] = [...parsed.stations];

    if (singleUrl) {
      if (!isPlayableStreamUrl(singleUrl)) {
        res.status(400).json({ error: "url 必须是 http(s) 地址" });
        return;
      }
      // Same private-host refusal as the playlist path: this URL is fetched by
      // the server, not the browser.
      if (!isImportableStreamUrl(singleUrl)) {
        res.status(400).json({ error: "不允许导入内网 / 本机地址" });
        return;
      }
      const fallbackName = new URL(singleUrl).host;
      const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : fallbackName;
      parsedStations.push({
        name,
        url: singleUrl,
        group: group ?? "本地导入",
        note: "",
        cover: cover ?? "",
      });
    }

    if (parsedStations.length === 0) {
      res.status(422).json({
        error: "没有解析到可用的电台",
        skipped: parsed.skipped,
      });
      return;
    }
    if (parsedStations.length > MAX_IMPORT_STATIONS) {
      res.status(413).json({
        error: `一次最多导入 ${MAX_IMPORT_STATIONS} 个电台`,
      });
      return;
    }

    // A group override from the request applies to anything the playlist did
    // not label itself; it never rewrites explicit group-titles.
    const rows = group
      ? parsedStations.map((s) => (s.group === "本地导入" ? { ...s, group } : s))
      : parsedStations;

    // A single-pasted URL with no `tvg-logo` gets the one supplied alongside
    // it. A playlist's own logos are left alone — those are per-station.
    const withCover = cover && !playlist.trim()
      ? rows.map((s) => (s.url === singleUrl ? { ...s, cover } : s))
      : rows;

    if (dryRun) {
      res.json({
        preview: withCover,
        skipped: parsed.skipped,
        wouldImport: withCover.length,
      });
      return;
    }

    try {
      const result = localStore.import(withCover);
      cache.clear(); // now-playing entries may belong to a re-imported URL
      logger.info({ ...result, group }, "Imported local radio stations");
      res.json({
        ...result,
        imported: withCover.length,
        skipped: parsed.skipped,
        groups: localStore.groups(),
      });
    } catch (err) {
      logger.error({ err }, "Local radio import failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /** Set (or clear) one station's cover art. */
  router.put("/local/:id/cover", requireStationAdmin, (req, res) => {
    if (!requireRadio(res)) return;
    if (!localStore) {
      unavailable(res);
      return;
    }
    const raw = (req.body as { cover?: unknown } | undefined)?.cover;
    const cover = typeof raw === "string" ? raw.trim() : "";
    if (cover && !/^https?:\/\//i.test(cover)) {
      res.status(400).json({ error: "cover 必须是 http(s) 图片地址" });
      return;
    }
    if (!localStore.setCover(req.params.id, cover)) {
      res.status(404).json({ error: "Station not found" });
      return;
    }
    logger.info({ id: req.params.id, cover }, "Updated local radio cover");
    res.json({ ok: true, stations: localStore.list().map(mapStationToSong) });
  });

  router.delete("/local/:id", requireStationAdmin, (req, res) => {
    if (!requireRadio(res)) return;
    if (!localStore) {
      unavailable(res);
      return;
    }
    const removed = localStore.remove(req.params.id);
    if (!removed) {
      res.status(404).json({ error: "Station not found" });
      return;
    }
    cache.delete(req.params.id);
    res.json({ ok: true, groups: localStore.groups() });
  });

  router.delete("/local", requireStationAdmin, (_req, res) => {
    if (!requireRadio(res)) return;
    if (!localStore) {
      unavailable(res);
      return;
    }
    const removed = localStore.clear();
    cache.clear();
    res.json({ ok: true, removed });
  });

  router.get("/stations/:id", async (req, res) => {
    if (!requireRadio(res)) return;
    try {
      const song = await radio!.getSongDetail(req.params.id);
      if (!song) {
        res.status(404).json({ error: "Station not found" });
        return;
      }
      res.json({ station: song });
    } catch (err) {
      logger.error({ err }, "Radio station lookup failed");
      res.status(502).json({ error: (err as Error).message });
    }
  });

  // ─── Live "now playing" ─────────────────────────────────────────────────

  /**
   * Reachability check for one station.
   *
   * A radio stream is an endless HTTP response, so "online" can only mean "the
   * server answered and started sending audio". Two probes, cheapest first:
   *
   *  1. A `HEAD`/`GET` with `Range: bytes=0-0`. Stations that understand Range
   *     answer immediately without streaming; the first body byte proves audio
   *     is flowing.
   *  2. A plain GET whose response is destroyed as soon as headers (or a few
   *     KB) arrive — the fallback for the many Icecast/nginx setups that ignore
   *     Range and would otherwise start an unbounded download.
   *
   * A `403`/`404`/`5xx` is offline; a timeout is "unknown" rather than offline,
   * because a slow station is still a playable one. Status is never derived from
   * the directory's `lastcheckok` — that column is often months stale.
   */
  async function probeStation(url: string): Promise<StationStatusResponse> {
    const started = Date.now();
    const result: StationStatusResponse = emptyStatus(url);
    result.checkedAt = new Date().toISOString();
    const apply = (state: StationStatus, httpStatus: number | null) => {
      result.state = state;
      result.online = state === "online";
      result.httpStatus = httpStatus;
      result.latencyMs = Date.now() - started;
    };

    try {
      const res = await fetchImpl(url, {
        method: "GET",
        headers: {
          // Ask for one byte: servers that honour Range answer and close, which
          // is the only cheap way to distinguish "streaming" from "hangs".
          Range: "bytes=0-0",
          "User-Agent": STATION_PROBE_UA,
          Accept: "*/*",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(STATION_PROBE_TIMEOUT_MS),
      });

      // Read a single byte to prove the body actually flows, then hang up. A
      // station that sends headers but no audio is exactly the dead case the
      // page is trying to surface.
      if (res.ok && res.body) {
        const reader = res.body.getReader();
        try {
          const { value, done } = await reader.read();
          if (!done && value && value.length > 0) apply("online", res.status);
          else apply("unknown", res.status);
        } finally {
          try { await reader.cancel(); } catch { /* already closed */ }
        }
      } else {
        // 4xx/5xx: the endpoint answered and refused, which is a definite no.
        apply("offline", res.status);
      }
      try { await res.body?.cancel(); } catch { /* ignore */ }
    } catch (err) {
      // A timeout or DNS failure says nothing about a station we have never
      // reached successfully; report unknown so the UI can stay neutral
      // instead of greying out a working station on a flaky probe.
      const name = (err as Error)?.name ?? "";
      if (name === "TimeoutError" || name === "AbortError") apply("unknown", null);
      else apply("offline", null);
    }
    return result;
  }

  /**
   * Reachability for one or more stations.
   *
   * `GET /api/radio/status?id=<uuid>&id=<uuid>…` or `?url=<stream>&url=…`.
   * `refresh=1` skips the short per-URL cache and re-probes (the "检测在线"
   * button). The page calls this once per render with every station it is
   * showing, so results are cached briefly and the batch is capped. Probes run
   * with limited concurrency — a directory page can hold ~50 stations and firing
   * 50 sockets at once is exactly the kind of load a public directory does not
   * want.
   */
  router.get("/status", async (req, res) => {
    if (!requireRadio(res)) return;

    const toList = (v: unknown): string[] =>
      (Array.isArray(v) ? v : typeof v === "string" ? [v] : [])
        .filter((x): x is string => typeof x === "string")
        .map((x) => x.trim())
        .filter(Boolean);

    const ids = toList(req.query.id).slice(0, MAX_STATUS_BATCH);
    const urls = toList(req.query.url).slice(0, MAX_STATUS_BATCH);
    if (ids.length === 0 && urls.length === 0) {
      res.status(400).json({ error: "id or url is required" });
      return;
    }

    // The page's "检测在线" button asks for a fresh probe: without this a click
    // right after the automatic check would simply replay the cached answer and
    // look like it did nothing.
    const force = req.query.refresh === "1" || req.query.refresh === "true";

    // Resolve every target to { key, url } first: imported stations answer from
    // disk, directory stations need one lookup each (already cached upstream).
    const targets: Array<{ key: string; url: string; directory?: RadioStation | null }> = [];
    for (const id of ids) {
      try {
        const stream = await radio!.getStationUrl(id);
        if (stream) targets.push({ key: id, url: stream });
        else targets.push({ key: id, url: "" });
      } catch {
        targets.push({ key: id, url: "" });
      }
    }
    for (const url of urls) targets.push({ key: url, url });

    const results = await mapLimit(targets, MAX_PARALLEL_PROBES, async (t) => {
      if (!isPlayableStreamUrl(t.url)) {
        return { ...emptyStatus(t.key), state: "offline" as StationStatus };
      }
      const cached = force ? undefined : statusCache.get(t.url);
      if (cached && Date.now() - cached.at < STATION_STATUS_TTL_MS) {
        return { ...cached.value, id: t.key };
      }
      const probed = await probeStation(t.url);
      // Note what the directory thinks, but never let it decide `online`.
      let fromDirectory = false;
      try {
        const dir = await radio!.lookupByUrl(t.url);
        fromDirectory = !!dir;
      } catch { /* directory down: the probe answer still stands */ }
      probed.id = t.key;
      probed.fromDirectory = fromDirectory;
      statusCache.set(t.url, { at: Date.now(), value: probed });
      return probed;
    });

    res.json({ statuses: results });
  });

  /**
   * The pinned 收藏电台 strip.
   *
   * Readable by anyone who can see the page (it is the same shared list
   * `/local` exposes); only mutations are gated, below.
   */
  router.get("/favorites", (_req, res) => {
    if (!requireRadio(res)) return;
    res.json({ favorites: favoriteSongs() });
  });

  /**
   * Star / unstar a station.
   *
   * Body: `{ station: Song, favorite: boolean }` — the page sends back the row
   * it rendered, so starring a directory result needs no extra lookup and the
   * favorite keeps working if the directory later drops the station.
   *
   * Not admin-gated like import: this is a personal-ish convenience on a shared
   * list, and it only ever *adds* a station that the user could already play.
   * Guests are still excluded — the shared list should not be shaped by
   * anonymous visitors.
   */
  router.post("/favorites", requireNotGuest, async (req, res) => {
    if (!requireRadio(res)) return;
    if (!localStore) {
      unavailable(res);
      return;
    }
    const body = (req.body ?? {}) as { station?: unknown; favorite?: unknown };
    const song = body.station as Partial<Song> | undefined;
    if (!song || typeof song !== "object" || typeof song.id !== "string" || typeof song.name !== "string") {
      res.status(400).json({ error: "station is required" });
      return;
    }
    const favorite = body.favorite !== false;

    try {
      // Resolve back to the full station record: a favorite of a directory
      // station must be stored with its real stationuuid, not the synthetic id
      // a favorite row would otherwise get.
      const station = radio ? await radio.getStation(song.id) : null;
      const record: RadioStation = station ?? {
        stationuuid: song.id,
        name: song.name,
        url: "", // never used: resolved below
        url_resolved: "",
        homepage: "",
        favicon: song.coverUrl ?? "",
        tags: song.album ?? "",
        country: song.artist ?? "",
        countrycode: "",
        state: "",
        language: "",
        codec: "",
        bitrate: 0,
        votes: 0,
      };
      if (!record.url && !record.url_resolved) {
        res.status(400).json({ error: "无法解析该电台的流地址" });
        return;
      }
      const result = localStore.setFavorite(record, favorite);
      statusCache.delete(record.url);
      res.json({
        ok: true,
        ...result,
        favorites: favoriteSongs(),
      });
    } catch (err) {
      logger.error({ err, id: song.id }, "Radio favorite failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/now-playing", async (req, res) => {
    if (!requireRadio(res)) return;
    const stationId = typeof req.query.id === "string" ? req.query.id : "";
    if (!stationId) {
      res.status(400).json({ error: "id is required" });
      return;
    }

    const hit = cache.get(stationId);
    if (hit && Date.now() - hit.at < NOW_PLAYING_TTL_MS) {
      res.json(hit.value);
      return;
    }

    try {
      const station = await radio!.getSongDetail(stationId);
      if (!station) {
        res.status(404).json({ error: "Station not found" });
        return;
      }
      const url = await radio!.getSongUrl(stationId);
      let value: NowPlayingResponse = {
        stationId,
        title: station.name,
        artist: station.artist,
        song: "",
        fromStream: false,
        fetchedAt: new Date().toISOString(),
      };
      if (url?.url) {
        const meta = await fetchStreamMetadata(url.url, { userAgent: "TSMusicBot" });
        if (meta) {
          value = {
            stationId,
            title: meta.title || station.name,
            artist: meta.artist,
            song: meta.song,
            fromStream: true,
            fetchedAt: new Date().toISOString(),
          };
        }
      }
      cache.set(stationId, { at: Date.now(), value });
      res.json(value);
    } catch (err) {
      logger.error({ err, stationId }, "Radio now-playing probe failed");
      res.status(502).json({ error: (err as Error).message });
    }
  });

  return router;
}
