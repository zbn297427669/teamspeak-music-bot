/**
 * Locally imported radio stations.
 *
 * Two things live here, both about stations the operator supplied rather than
 * the ones the Radio Browser directory returns:
 *
 *  1. **M3U/M3U8 playlists** — parsed by `parseM3u`. The extended `#EXTINF`
 *     line carries `group-title` and a display name; both survive into the
 *     stored station so the UI can group and label imports the way the file
 *     did.
 *  2. **A JSON station file on disk** — `LocalRadioStore` reads, writes and
 *     merges it. It is deliberately a plain JSON document next to config.json
 *     rather than a DB table: it is operator-owned data that is worth reading
 *     and hand-editing, and it has no relational needs.
 *
 * Imported stations are ordinary `RadioStation` records with a synthetic
 * `stationuuid` (`local:<hash>`), so `RadioProvider` resolves their stream URL
 * and `mapStationToSong` projects them exactly like a directory station. That
 * is what lets local stations ride the existing queue with no second playback
 * path.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Logger } from "../logger.js";
import { knownCoverFor } from "./radio-covers.js";
import { isImportableStreamUrl, isPlayableStreamUrl, type RadioStation } from "./radio.js";

/** Group used when a playlist (or a single pasted URL) carries no group. */
export const DEFAULT_GROUP = "本地导入";

/** Group a directory station is filed under when it is starred, so the row has
 *  a sensible section if it ever shows up outside the favorites strip. */
export const FAVORITE_GROUP = "收藏";

export interface LocalRadioStation extends RadioStation {
  /** Playlist group-title, or DEFAULT_GROUP. Drives grouping in the UI. */
  group: string;
  /** True for operator-imported rows — the UI shows a "本地" chip and the
   *  import/delete actions only appear for these. */
  local: true;
  /** False for a row that exists *only* because a directory station was
   *  starred: it has no import metadata, so it belongs to 收藏电台 and not to
   *  我的电台. Missing means true, which is what an older row or a hand-written
   *  entry is. */
  imported?: boolean;
  /** Pinned to the top of the radio page. Set for imports the user starred and
   *  for directory stations starred from the browse list; the latter are
   *  persisted here so a favorite survives the directory being unreachable. */
  favorite?: boolean;
  /** ISO timestamp of when the star was last set. Orders the pinned strip
   *  newest-first; rows from before this field simply sort last. */
  favoritedAt?: string;
}

export interface ParsedStation {
  name: string;
  url: string;
  group: string;
  /** Anything after the name in `#EXTINF`, e.g. the FM frequency. Kept as-is
   *  so the UI can show it without re-parsing the original line. */
  note: string;
  /** `tvg-logo` artwork, when the playlist supplied one. Stored as the
   *  station's `favicon`, which is what the UI renders as cover art. */
  cover?: string;
}

export interface ParseResult {
  stations: ParsedStation[];
  /** Entries that were skipped, with the reason. Surfaced to the operator so a
   *  half-broken playlist is not silently half-imported. */
  skipped: Array<{ line: number; reason: string; raw: string }>;
}

/** Split a display name from its trailing descriptor.
 *
 *  The source file mixes `名称 FM94.7 · 上海`, `名称 湖南` and plain `名称`, so
 *  there is no separator to rely on. We treat a trailing run that starts with a
 *  city/region marker (`· 上海`) or an `FM` frequency as the note. */
export function splitNameAndNote(title: string): { name: string; note: string } {
  const trimmed = title.trim();
  if (!trimmed) return { name: "", note: "" };
  // `XM 名称 ... · 地区` — the dot is an explicit separator.
  const dot = trimmed.lastIndexOf("·");
  if (dot > 0) {
    return { name: trimmed.slice(0, dot).trim(), note: trimmed.slice(dot + 1).trim() };
  }
  // `名称 FM94.7` / `名称 FM97.6-98.9` — the frequency belongs to the note.
  const fm = /^(.*?)\s+(FM\s*[\d.]+(?:\s*-\s*[\d.]+)?)$/i.exec(trimmed);
  if (fm && fm[1].trim()) {
    return { name: fm[1].trim(), note: fm[2].trim() };
  }
  return { name: trimmed, note: "" };
}

/**
 * Parse an M3U/M3U8 playlist (or a bare list of URLs).
 *
 * `#EXTINF:<duration> [attrs],<title>` — `group-title` and `tvg-logo` are
 * consumed; other attributes are ignored rather than rejected, because
 * playlist exporters add different ones (tvg-id, radio="true") and none of
 * them affect playback. A URL line without a preceding `#EXTINF` is imported
 * with the URL host as its name, which is what a hand-pasted list looks like.
 */
export function parseM3u(content: string): ParseResult {
  const stations: ParsedStation[] = [];
  const skipped: ParseResult["skipped"] = [];
  let pending: { title: string; group: string; cover: string } | null = null;

  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      // #EXTM3U / #EXTGRP / comments are not station metadata. Only #EXTINF
      // starts a station; anything else is ignored.
      if (!line.startsWith("#EXTINF")) continue;
      const comma = line.indexOf(",");
      const attrs = comma >= 0 ? line.slice(0, comma) : line;
      const title = comma >= 0 ? line.slice(comma + 1).trim() : "";
      const group = /group-title="([^"]*)"/i.exec(attrs)?.[1]?.trim() || DEFAULT_GROUP;
      const cover = /tvg-logo="([^"]*)"/i.exec(attrs)?.[1]?.trim() || "";
      pending = { title, group, cover };
      continue;
    }

    if (!isPlayableStreamUrl(line)) {
      skipped.push({ line: i + 1, reason: "不是 http(s) 流地址", raw: line });
      pending = null;
      continue;
    }
    // An import is user input that the server will later fetch, so private and
    // loopback hosts are refused here rather than handed to ffmpeg / the ICY
    // probe. Reading the file back (list()) uses the looser playback gate, so a
    // station an operator added by hand on their LAN keeps working.
    if (!isImportableStreamUrl(line)) {
      skipped.push({ line: i + 1, reason: "不允许导入内网 / 本机地址", raw: line });
      pending = null;
      continue;
    }

    if (pending) {
      const { name, note } = splitNameAndNote(pending.title);
      stations.push({
        name: name || new URL(line).host,
        url: line,
        group: pending.group,
        note,
        cover: pending.cover,
      });
      pending = null;
    } else {
      // Bare URL, no #EXTINF.
      stations.push({ name: new URL(line).host, url: line, group: DEFAULT_GROUP, note: "" });
    }
  }

  if (pending) {
    skipped.push({
      line: lines.length,
      reason: "#EXTINF 之后没有流地址",
      raw: pending.title,
    });
  }
  return { stations, skipped };
}

/** Stable synthetic uuid so re-importing the same URL updates the existing row
 *  instead of creating a duplicate. Same shape as a real stationuuid (a UUID)
 *  so nothing downstream has to special-case ours. */
export function localStationId(url: string): string {
  const hex = createHash("sha1").update(url.trim().toLowerCase()).digest("hex");
  // 8-4-4-4-12 with version/variant nibbles set, purely to look like a UUID.
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `a${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

/** Project a parsed row into the directory record shape the provider already
 *  understands. `url_resolved` is set to the same value so `stationStreamUrl`
 *  picks it up without an extra round trip. */
export function toRadioStation(station: ParsedStation): LocalRadioStation {
  return {
    stationuuid: localStationId(station.url),
    name: station.name,
    url: station.url,
    url_resolved: station.url,
    homepage: "",
    // Order matters: an explicit `tvg-logo` from the playlist wins, then the
    // curated table, then nothing. Without this layer most Chinese playlists
    // import with no artwork at all.
    favicon: station.cover?.trim() || knownCoverFor(station.url),
    tags: station.note ? `${station.group},${station.note}` : station.group,
    country: "",
    countrycode: "",
    state: "",
    language: "",
    codec: "",
    bitrate: 0,
    votes: 0,
    group: station.group || DEFAULT_GROUP,
    local: true,
    imported: true,
  };
}

const FILE_VERSION = 1;

interface StationFile {
  version: number;
  stations: LocalRadioStation[];
}

/**
 * Reads and writes `data/local-radio.json`.
 *
 * Every read goes to disk (the file is small and hand-editable, so an operator
 * editing it should see the change without a restart); writes are atomic via a
 * temp file + rename so a crash mid-write cannot truncate the station list.
 * A malformed file is reported and treated as empty rather than crashing the
 * bot — losing the imported list must never take the whole service down.
 */
export class LocalRadioStore {
  private readonly path: string;
  private readonly logger: Logger;

  constructor(path: string, logger: Logger) {
    this.path = path;
    this.logger = logger;
  }

  get filePath(): string {
    return this.path;
  }

  list(): LocalRadioStation[] {
    if (!existsSync(this.path)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<StationFile>;
      const rows = Array.isArray(parsed?.stations) ? parsed.stations : [];
      // Re-validate on read: the file is hand-editable, so a bad URL must be
      // dropped here rather than handed to ffmpeg later.
      return rows
        .filter(
          (s): s is LocalRadioStation =>
            !!s &&
            typeof s.stationuuid === "string" &&
            typeof s.name === "string" &&
            typeof s.url === "string" &&
            isPlayableStreamUrl(s.url),
        )
        .map((s) => ({
          ...s,
          group: s.group || DEFAULT_GROUP,
          // A starred directory station is stored here too (that is what makes
          // the favorite survive a directory outage), but it has no import
          // metadata. Anything that was written before this flag existed, or by
          // hand, counts as imported.
          imported: s.imported !== false,
          local: true as const,
        }));
    } catch (err) {
      this.logger.warn({ err, path: this.path }, "local-radio.json is unreadable; treating as empty");
      return [];
    }
  }

  private write(stations: LocalRadioStation[]): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const body: StationFile = { version: FILE_VERSION, stations };
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, "utf8");
    renameSync(tmp, this.path);
  }

  /**
   * Merge parsed rows into the store, keyed by stream URL.
   *
   * Re-importing a playlist is the expected workflow (the source file gets
   * refreshed), so an existing URL is updated in place — name and group follow
   * the file — while stations that are not in the import are left alone. That
   * means an import can never silently delete something the operator added by
   * hand.
   *
   * Cover art is the exception: when the playlist carries no `tvg-logo`, the
   * existing `favicon` is kept. Most playlists omit the logo entirely, so
   * letting an empty value win would wipe every cover the operator set.
   */
  import(parsed: ParsedStation[]): { added: number; updated: number; total: number } {
    const current = this.list();
    const byUrl = new Map(current.map((s) => [s.url.trim().toLowerCase(), s]));
    let added = 0;
    let updated = 0;

    for (const row of parsed) {
      const key = row.url.trim().toLowerCase();
      const existing = byUrl.get(key);
      const next = toRadioStation(row);
      if (existing) {
        byUrl.set(key, {
          ...existing,
          ...next,
          stationuuid: existing.stationuuid,
          favicon: next.favicon || existing.favicon,
        });
        updated++;
      } else {
        byUrl.set(key, next);
        added++;
      }
    }

    const merged = [...byUrl.values()];
    this.write(merged);
    return { added, updated, total: merged.length };
  }

  /** Point a station's cover art at `cover` (empty clears it).
   *
   *  Separate from `import` because artwork is operator data that does not
   *  come from the playlist: the same station is re-imported from the same
   *  M3U every time, and the cover must survive that. */
  setCover(stationuuid: string, cover: string): boolean {
    const current = this.list();
    const index = current.findIndex((s) => s.stationuuid === stationuuid);
    if (index < 0) return false;
    current[index] = { ...current[index], favicon: cover.trim() };
    this.write(current);
    return true;
  }

  /** Remove by synthetic id. Returns whether anything was removed. */
  remove(stationuuid: string): boolean {
    const current = this.list();
    const next = current.filter((s) => s.stationuuid !== stationuuid);
    if (next.length === current.length) return false;
    this.write(next);
    return true;
  }

  /** Drop every imported station. */
  clear(): number {
    const count = this.list().length;
    this.write([]);
    return count;
  }

  find(stationuuid: string): LocalRadioStation | null {
    return this.list().find((s) => s.stationuuid === stationuuid) ?? null;
  }

  /** Distinct group titles, in first-seen order, with counts — drives the
   *  "我的电台" grouping in the UI. Starred-only rows are skipped: their
   *  FAVORITE_GROUP would otherwise offer a "收藏" group in the filter that
   *  filters imports by a name no import has. */
  groups(): Array<{ name: string; count: number }> {
    const seen = new Map<string, number>();
    for (const s of this.list()) {
      if (s.imported === false) continue;
      seen.set(s.group, (seen.get(s.group) ?? 0) + 1);
    }
    return [...seen.entries()].map(([name, count]) => ({ name, count }));
  }

  /** The operator's own imports, i.e. the rows 我的电台 renders. */
  imports(): LocalRadioStation[] {
    return this.list().filter((s) => s.imported !== false);
  }

  // ─── Favorites ──────────────────────────────────────────────────────────
  //
  // Favoriting is a *flag* on the row, not a separate list. Two reasons:
  //
  //  - One row per station keeps the file's invariant (URL is the key), so a
  //    station can never exist twice — once as a directory result the user
  //    starred and once as an import.
  //  - Starring a station the directory returned has to write *something*
  //    local; storing the station itself is what makes the favorite survive a
  //    directory outage, which is the whole point of pinning it to the top.

  /**
   * Star or unstar a station.
   *
   * `station` is only used when starring a station that is not imported yet:
   * it is persisted verbatim so the favorite keeps working without the
   * directory (and so it shows up in 我的电台 even when the directory is down).
   * Unstarring an import's own row keeps the import, it just clears the flag.
   */
  setFavorite(station: RadioStation, favorite: boolean): { favorited: boolean; created: boolean } {
    const current = this.list();
    const key = station.url.trim().toLowerCase();
    const index = current.findIndex((s) => s.url.trim().toLowerCase() === key);
    const now = new Date().toISOString();

    if (index >= 0) {
      const row = current[index];
      if (favorite) {
        current[index] = { ...row, favorite: true, favoritedAt: now };
      } else if (row.imported === false) {
        // The row exists for its star alone; unstarring leaves nothing behind.
        current[index] = { ...row, favorite: false };
        current.splice(index, 1);
      } else {
        // An imported row keeps existing — only the pin goes away.
        const { favoritedAt: _drop, ...rest } = row;
        current[index] = { ...rest, favorite: false };
      }
      this.write(current);
      return { favorited: favorite, created: false };
    }
    if (!favorite) return { favorited: false, created: false };

    if (!isImportableStreamUrl(station.url)) {
      throw new Error("该电台地址不允许收藏（内网 / 本机地址）");
    }
    const row: LocalRadioStation = {
      ...toRadioStation({
        name: station.name,
        url: station.url,
        group: FAVORITE_GROUP,
        note: "",
        cover: station.favicon ?? "",
      }),
      favorite: true,
      favoritedAt: now,
      // Not an import: it must not show up in 我的电台, whose rows are the
      // operator's own playlists.
      imported: false,
      // Keep the directory identity: it is what lets the page resolve the
      // stream and show the now-playing title for a favorite that is not an
      // import (its synthetic id would mean nothing to the directory).
      stationuuid: station.stationuuid || localStationId(station.url),
    };
    current.push(row);
    this.write(current);
    return { favorited: true, created: true };
  }

  /** Favorited stations, most recently starred first (that is the order the
   *  pinned strip shows). Imported favorites and starred-only rows both count. */
  favorites(): LocalRadioStation[] {
    return this.list()
      .filter((s) => s.favorite === true)
      .sort((a, b) => (b.favoritedAt ?? "").localeCompare(a.favoritedAt ?? ""));
  }

  /** Whether this exact stream is starred. */
  isFavorite(url: string): boolean {
    const key = url.trim().toLowerCase();
    return this.list().some((s) => s.favorite === true && s.url.trim().toLowerCase() === key);
  }
}
