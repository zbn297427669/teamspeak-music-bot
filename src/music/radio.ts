/**
 * Internet-radio provider backed by the public Radio Browser directory
 * (https://www.radio-browser.info).
 *
 * Every station is a LIVE stream: it has no duration, never reaches a natural
 * end, and cannot be seeked. Stations are modeled as ordinary `Song`s with
 * `live: true` so they flow through the existing queue, player, WebSocket
 * status and FM machinery instead of a parallel playback path.
 *
 * Logic adapted from Traydio (MIT, https://github.com/TheJoeFin/Traydio),
 * specifically its RadioBrowserService parameter mapping and station → model
 * projection. No WinUI/audio code is reused — this is a plain HTTP client.
 */

import type {
  Album,
  AuthStatus,
  LyricLine,
  MusicProvider,
  Playlist,
  PlaylistDetail,
  QrCodeResult,
  SearchResult,
  Song,
  SongUrlResult,
} from "./provider.js";
import type { Logger } from "../logger.js";
import type { LocalRadioStation } from "./radio-local.js";

/** Mirrors the subset of the Radio Browser station record we consume. */
export interface RadioStation {
  stationuuid: string;
  name: string;
  url: string;
  url_resolved: string;
  homepage: string;
  favicon: string;
  tags: string;
  country: string;
  countrycode: string;
  state: string;
  language: string;
  codec: string;
  bitrate: number;
  votes: number;
  clickcount?: number;
  hls?: number;
  /** Directory-reported reachability. Only the `byurl` lookup is guaranteed to
   *  carry it — search/top endpoints may omit it — so the router treats it as
   *  a hint, never as proof. */
  lastcheckok?: number;
  lastchecktime?: string;
  lastcheckoktime?: string;
  lastchangetime?: string;
}

/** Faceted search, mirroring Traydio's StationSearchQuery. Empty fields are
 *  omitted from the request. */
export interface RadioSearchQuery {
  name?: string;
  country?: string;
  language?: string;
  tags?: string[];
  codec?: string;
  bitrateMin?: number;
  /** votes | clickcount | name | bitrate | random */
  order?: string;
  reverse?: boolean;
  hideBroken?: boolean;
  limit?: number;
  offset?: number;
}

export interface RadioFacets {
  tags: Array<{ name: string; stationcount: number }>;
  countries: Array<{ name: string; iso_3166_1: string; stationcount: number }>;
  languages: Array<{ name: string; stationcount: number }>;
}

/**
 * Radio Browser asks clients to pick a specific mirror rather than hammer the
 * round-robin alias, and to fall through when one is down. Order matches
 * availability observed in practice; each retry is independent.
 */
const MIRRORS = [
  "https://de1.api.radio-browser.info",
  "https://de2.api.radio-browser.info",
  "https://fi1.api.radio-browser.info",
  "https://at1.api.radio-browser.info",
];

const USER_AGENT = "TSMusicBot (+https://github.com/ZHANGTIANYAO1/teamspeak-music-bot)";
const REQUEST_TIMEOUT_MS = 10_000;

/** Anything that is not a plain http(s) URL is refused before it can reach
 *  ffmpeg — the directory is user-populated and has contained `javascript:`
 *  and other junk URLs. */
export function isPlayableStreamUrl(url: string): boolean {
  if (typeof url !== "string") return false;
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * True for a host that must never be dialled on behalf of a user.
 *
 * A station URL is attacker-controlled: it arrives from a pasted M3U or the
 * public Radio Browser directory and is then fetched by the *server* — both by
 * ffmpeg and by the /now-playing ICY probe. Without this, an import of
 * `http://127.0.0.1:3001/api/...` would make the bot talk to its own
 * sidecars (or any machine on the LAN / cloud metadata endpoint) and, for the
 * probe, leak the response back through the API.
 *
 * Only the literal hostname is checked — no DNS resolution. A hostile DNS name
 * pointing at 127.0.0.1 still gets through, which is an accepted limitation:
 * resolving here would need a rebinding-safe connect and would also break
 * stations behind round-robin DNS. The public directory is the intended
 * source; this stops the trivially abusable cases.
 */
export function isBlockedStreamHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return true;
  // localhost and its mDNS aliases
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  // IPv6 loopback / unspecified / unique-local / link-local
  if (host === "::1" || host === "::" ) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true;
  // IPv4, with IPv4-mapped IPv6 stripped to its v4 part above.
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!v4) return false;
  const octets = v4.slice(1).map(Number);
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = octets;
  if (a === 0) return true; // "this network"
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  return false;
}

/**
 * Whether a *user-supplied* station URL is acceptable for import.
 *
 * Stricter than `isPlayableStreamUrl`, which is the playback gate: that one
 * must keep accepting whatever the directory and the on-disk file already
 * contain (an operator running a station on their LAN has to be able to play
 * it). This gate is only applied to NEW user input, so it closes the SSRF door
 * without invalidating existing data.
 */
export function isImportableStreamUrl(url: string): boolean {
  if (!isPlayableStreamUrl(url)) return false;
  try {
    return !isBlockedStreamHost(new URL(url.trim()).hostname);
  } catch {
    return false;
  }
}

/** Prefer the directory's resolved URL (follows playlists/redirects to the
 *  actual stream) and fall back to the as-submitted one. */
export function stationStreamUrl(station: Pick<RadioStation, "url" | "url_resolved">): string {
  const resolved = (station.url_resolved ?? "").trim();
  if (resolved && isPlayableStreamUrl(resolved)) return resolved;
  const raw = (station.url ?? "").trim();
  return isPlayableStreamUrl(raw) ? raw : "";
}

function clean(value: string | undefined | null): string {
  return typeof value === "string" ? value.trim() : "";
}

/** In-place Fisher–Yates, returning the same array for chaining. */
function shuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

/** Project a directory record into a queue-ready Song. `duration` is 0 because
 *  the stream is endless; `live` tells the player and UI not to treat that as
 *  "unknown length song".
 *
 *  Imported stations carry a `group` and no country, so the group becomes the
 *  queue row's descriptor — "古典·轻音·治愈" says more than "网络电台". */
export function mapStationToSong(
  station: RadioStation & { group?: string },
): Song {
  const country = clean(station.country);
  const language = clean(station.language);
  const tags = clean(station.tags);
  return {
    id: station.stationuuid,
    name: clean(station.name) || "Unknown station",
    // No per-track artist exists before playback; the country/language/group is
    // the most useful stable descriptor for the queue row.
    artist: country || language || clean(station.group) || "网络电台",
    album: tags,
    duration: 0,
    coverUrl: clean(station.favicon),
    platform: "radio",
    live: true,
  };
}

/** The subset of LocalRadioStore the provider needs. Typed structurally so the
 *  provider does not have to import the file-backed store (and its fs
 *  dependencies) just to be testable. */
export interface LocalStationSource {
  list(): LocalRadioStation[];
  find(stationuuid: string): LocalRadioStation | null;
}

export interface RadioProviderOptions {
  logger: Logger;
  /** Override the mirror list (tests / self-hosted directory). */
  mirrors?: string[];
  /** `fetch` injection for tests. */
  fetchImpl?: typeof fetch;
  /** Operator-imported stations. They are resolved before the directory is
   *  consulted, so a local station keeps playing even when Radio Browser is
   *  unreachable. */
  localStations?: LocalStationSource;
}

export class RadioProvider implements MusicProvider {
  readonly platform = "radio" as const;

  private readonly logger: Logger;
  private readonly mirrors: string[];
  private readonly fetchImpl: typeof fetch;
  private readonly localStations: LocalStationSource | null;
  private readonly cache = new Map<string, { at: number; value: unknown }>();
  private quality = "best";

  /** Facets change slowly and are large; cache them longer than searches. */
  private static readonly FACET_TTL_MS = 6 * 60 * 60 * 1000;
  private static readonly SEARCH_TTL_MS = 60 * 1000;

  constructor(options: RadioProviderOptions) {
    this.logger = options.logger;
    this.mirrors = options.mirrors?.length ? options.mirrors : MIRRORS;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.localStations = options.localStations ?? null;
  }

  // ─── Directory HTTP ─────────────────────────────────────────────────────

  /** GET a path from the first mirror that answers. A mirror that fails is
   *  tried only once per call, so a total outage costs mirrors×timeout. */
  private async request<T>(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
    let lastError: unknown;
    for (const mirror of this.mirrors) {
      try {
        const res = await this.fetchImpl(`${mirror}${path}`, {
          ...init,
          signal: AbortSignal.timeout(init?.timeoutMs ?? REQUEST_TIMEOUT_MS),
          headers: {
            "User-Agent": USER_AGENT,
            Accept: "application/json",
            ...(init?.headers ?? {}),
          },
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status} from ${mirror}${path}`);
        }
        return (await res.json()) as T;
      } catch (err) {
        lastError = err;
        this.logger.debug({ err, mirror }, "Radio Browser mirror failed, trying next");
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("All Radio Browser mirrors are unreachable");
  }

  private async cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
    const value = await load();
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  // ─── Directory queries ──────────────────────────────────────────────────

  async searchStations(query: RadioSearchQuery): Promise<RadioStation[]> {
    const params = new URLSearchParams();
    const set = (k: string, v: string | number | undefined) => {
      if (v === undefined || v === null || v === "") return;
      params.set(k, String(v));
    };
    set("name", query.name?.trim());
    set("country", query.country?.trim());
    set("language", query.language?.trim());
    if (query.tags?.length) set("tagList", query.tags.join(",").trim());
    set("codec", query.codec?.trim());
    set("bitrateMin", query.bitrateMin);
    set("order", query.order ?? "votes");
    set("reverse", String(query.reverse ?? true));
    set("hidebroken", String(query.hideBroken ?? true));
    set("limit", query.limit ?? 50);
    set("offset", query.offset);

    // Nothing to search on → the endpoint answers with an unfiltered dump.
    // Return empty instead, matching Traydio's StationSearchQuery.IsEmpty.
    const hasCriteria = ["name", "country", "language", "tagList", "codec", "bitrateMin"]
      .some((k) => params.has(k));
    if (!hasCriteria) return [];

    const key = `search:${params.toString()}`;
    return this.cached(key, RadioProvider.SEARCH_TTL_MS, async () => {
      const rows = await this.request<RadioStation[]>(
        `/json/stations/search?${params.toString()}`,
      );
      return (rows ?? []).filter((s) => stationStreamUrl(s) !== "");
    });
  }

  /** Top stations by votes — used for the page's default listing and for FM. */
  async topStations(limit = 50): Promise<RadioStation[]> {
    return this.cached(`top:${limit}`, RadioProvider.SEARCH_TTL_MS, async () => {
      const rows = await this.request<RadioStation[]>(
        `/json/stations/topvote/${limit}`,
      );
      return (rows ?? []).filter((s) => stationStreamUrl(s) !== "");
    });
  }

  async getStation(uuid: string): Promise<RadioStation | null> {
    // Imported stations are answered locally: they must keep working when the
    // directory is unreachable, and the directory knows nothing about them.
    const local = this.localStations?.find(uuid);
    if (local) return local;
    const rows = await this.request<RadioStation[]>(
      `/json/stations/byuuid/${encodeURIComponent(uuid)}`,
    );
    const station = rows?.[0];
    return station && stationStreamUrl(station) ? station : null;
  }

  /** Playable stream URL for a station, or "" when it has none. Thin wrapper so
   *  callers (the status probe, the player) never have to know about
   *  `stationStreamUrl` and the resolved-vs-raw ordering. */
  async getStationUrl(uuid: string): Promise<string> {
    const station = await this.getStation(uuid);
    return station ? stationStreamUrl(station) : "";
  }

  /**
   * Look a station up in the directory by its stream URL.
   *
   * `byurl` matches the exact submitted URL and is the only endpoint that
   * reliably carries `lastcheckok`, which is what the online-status probe
   * needs. It returns [] for stations the directory does not know (imports,
   * private playlists), which is a valid "no opinion" answer rather than an
   * error.
   */
  async lookupByUrl(url: string): Promise<RadioStation | null> {
    const trimmed = url.trim();
    if (!isPlayableStreamUrl(trimmed)) return null;
    const rows = await this.request<RadioStation[]>(
      `/json/stations/byurl?url=${encodeURIComponent(trimmed)}`,
    );
    return rows?.[0] ?? null;
  }

  /** Every station the provider can serve from disk: the operator's imports
   *  plus starred-only rows. Both keep working when the directory is down,
   *  which is why favorites are stored here too. */
  listLocalStations(): LocalRadioStation[] {
    return this.localStations?.list() ?? [];
  }

  /** Stations stored on disk matching a free-text query, filtered over name,
   *  group and note. Matching locally is intentional: the directory cannot
   *  index these, so a search that only hit the directory would hide them. */
  searchLocalStations(query: string): LocalRadioStation[] {
    const all = this.listLocalStations();
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter((s) =>
      [s.name, s.group, s.tags].some((field) => field.toLowerCase().includes(q)),
    );
  }

  async getFacets(): Promise<RadioFacets> {
    const [tags, countries, languages] = await Promise.all([
      this.cached("facets:tags", RadioProvider.FACET_TTL_MS, () =>
        this.request<RadioFacets["tags"]>(
          "/json/tags?order=stationcount&reverse=true&hidebroken=true&limit=120",
        ),
      ),
      this.cached("facets:countries", RadioProvider.FACET_TTL_MS, () =>
        this.request<RadioFacets["countries"]>(
          "/json/countries?order=stationcount&reverse=true&hidebroken=true",
        ),
      ),
      this.cached("facets:languages", RadioProvider.FACET_TTL_MS, () =>
        this.request<RadioFacets["languages"]>(
          "/json/languages?order=stationcount&reverse=true&hidebroken=true",
        ),
      ),
    ]);
    return { tags: tags ?? [], countries: countries ?? [], languages: languages ?? [] };
  }

  // ─── MusicProvider ─────────────────────────────────────────────────────

  async search(query: string, limit = 20, offset = 0): Promise<SearchResult> {
    const q = query.trim();
    if (!q) return { songs: [], playlists: [], albums: [] };
    // Imported stations are matched locally and listed first: they are the
    // stations the operator explicitly curated, so they should not be buried
    // under directory results.
    const local = this.searchLocalStations(q).map(mapStationToSong);
    const stations = await this.searchStations({ name: q, limit, offset, hideBroken: true });
    return {
      songs: [...local, ...stations.map(mapStationToSong)].slice(0, limit),
      playlists: [],
      albums: [],
    };
  }

  async getSongUrl(songId: string): Promise<SongUrlResult | null> {
    const station = await this.getStation(songId);
    if (!station) return null;
    return { url: stationStreamUrl(station) };
  }

  async getSongDetail(songId: string): Promise<Song | null> {
    const station = await this.getStation(songId);
    return station ? mapStationToSong(station) : null;
  }

  /** Radio has no per-user taste profile; a rotating slice of top stations is
   *  the honest analogue of "personal FM". Stations stored on disk (imports and
   *  favorites) are mixed in so an FM session actually uses the operator's
   *  curated list.
   *
   *  A directory outage must not take that list down with it: those stations
   *  are served from disk, so on a failed top-stations lookup they still make
   *  an FM session (an empty array would surface as "need to login", which is
   *  nonsense for an anonymous source). */
  async getPersonalFm(): Promise<Song[]> {
    const local = shuffle(this.listLocalStations().map(mapStationToSong));
    let stations: Song[] = [];
    try {
      stations = (await this.topStations(60)).map(mapStationToSong);
    } catch (err) {
      this.logger.warn({ err }, "Radio directory unreachable — FM falling back to imported stations");
    }
    return shuffle([...local, ...stations]).slice(0, 20);
  }

  getRecommendPlaylists(): Promise<Playlist[]> {
    return Promise.resolve([]);
  }

  getPlaylistSongs(_playlistId: string): Promise<Song[]> {
    return Promise.resolve([]);
  }

  getAlbumSongs(_albumId: string): Promise<Song[]> {
    return Promise.resolve([]);
  }

  getLyrics(_songId: string): Promise<LyricLine[]> {
    // A live stream has no lyrics; the ICY title is the only "now playing" text.
    return Promise.resolve([]);
  }

  getPlaylistDetail(_playlistId: string): Promise<PlaylistDetail | null> {
    return Promise.resolve(null);
  }

  getQrCode(): Promise<QrCodeResult> {
    return Promise.reject(new Error("Radio does not require login"));
  }

  checkQrCodeStatus(
    _key: string,
  ): Promise<"waiting" | "scanned" | "confirmed" | "expired"> {
    return Promise.resolve("expired");
  }

  setCookie(_cookie: string): void {
    // The directory is anonymous.
  }

  getCookie(): string {
    return "";
  }

  async getAuthStatus(): Promise<AuthStatus> {
    return { loggedIn: true, nickname: "网络电台" };
  }

  setQuality(quality: string): void {
    this.quality = quality;
  }

  getQuality(): string {
    return this.quality;
  }

  /** Test hook: drop every memoized response. */
  clearCache(): void {
    this.cache.clear();
  }
}

/** Albums are unused by radio; exported only to keep the type surface honest
 *  if a future directory lookup needs them. */
export type RadioAlbum = Album;
