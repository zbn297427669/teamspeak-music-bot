/**
 * Live metadata for internet radio streams (ICY / Icecast / SHOUTcast).
 *
 * ffmpeg's own icy support is not usable here: it is off by default, its output
 * format is version-dependent, and it cannot be polled independently of
 * playback. Instead we open a short-lived second connection, ask for one
 * metadata block, read it, and hang up — the audio path is untouched.
 *
 * Protocol (RFC 7827-ish, de facto Icecast):
 *   1. GET with `Icy-MetaData: 1`.
 *   2. Response carries `icy-metaint: N` (bytes of audio between blocks).
 *   3. Discard N bytes of audio, then read one length byte L.
 *   4. Read L * 16 bytes of metadata (zero-padded).
 *   5. `StreamTitle='Artist - Song';` inside it.
 *
 * Adapted from Traydio's StreamMetadataService (MIT), including its handling of
 * the iHeartRadio "Exploring" variant.
 */

import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

export interface StreamMetadata {
  /** Raw `StreamTitle` value, e.g. "Miles Davis - So What". */
  title: string;
  /** Best-effort split of `title` on the first " - ". */
  artist: string;
  song: string;
}

export interface FetchMetadataOptions {
  timeoutMs?: number;
  userAgent?: string;
}

/** Parse a raw ICY metadata string. Exported for tests. */
export function parseIcyMetadata(raw: string): StreamMetadata | null {
  const text = raw.replace(/\0+$/, "").trim();
  if (!text) return null;

  // iHeartRadio and some others send: Exploring title="Song",artist="Artist",...
  if (/^Exploring\s/i.test(text)) {
    const song = attr(text, "title");
    const artist = attr(text, "artist");
    if (!song && !artist) return null;
    return { title: [artist, song].filter(Boolean).join(" - "), artist, song };
  }

  // Standard: StreamTitle='Artist - Song';
  const m = /StreamTitle='((?:[^'\\]|\\.)*)'/i.exec(text);
  if (!m) return null;
  const title = unescapeIcy(m[1]).trim();
  if (!title) return null;

  // Some stations (iHeartRadio and friends) embed attributes inside
  // StreamTitle itself: 'Miles Davis - text="So What" amgArtworkURL="..."'.
  // The artist is whatever precedes " - text=".
  if (/\btext="/i.test(title)) {
    const song = attr(title, "text");
    let artist = attr(title, "artist");
    if (!artist) {
      const cut = title.toLowerCase().indexOf(' - text="');
      if (cut > 0) artist = unescapeIcy(title.slice(0, cut)).trim();
    }
    if (song) return { title, artist, song };
  }

  return { ...splitArtistTitle(title), title };
}

function attr(haystack: string, name: string): string {
  const m = new RegExp(`${name}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`, "i").exec(haystack);
  return m ? unescapeIcy(m[1]).trim() : "";
}

function unescapeIcy(value: string): string {
  return value.replace(/\\(.)/g, "$1");
}

/** "Artist - Song" → { artist, song }. Falls back to the whole string as the
 *  song when no separator is present, which is common for talk stations. */
export function splitArtistTitle(title: string): { artist: string; song: string } {
  const idx = title.indexOf(" - ");
  if (idx <= 0) return { artist: "", song: title };
  return {
    artist: title.slice(0, idx).trim(),
    song: title.slice(idx + 3).trim(),
  };
}

/**
 * Fetch one metadata block. Resolves null when the stream has no ICY metadata,
 * sent nothing within the budget, or errored — callers treat all three the same
 * way (fall back to the station name).
 */
export function fetchStreamMetadata(
  streamUrl: string,
  options: FetchMetadataOptions = {},
): Promise<StreamMetadata | null> {
  const { timeoutMs = 6000, userAgent = "TSMusicBot" } = options;

  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (value: StreamMetadata | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        req.destroy();
      } catch {
        /* already gone */
      }
      resolve(value);
    };

    let url: URL;
    try {
      url = new URL(streamUrl);
    } catch {
      resolve(null);
      return;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      resolve(null);
      return;
    }

    const transport = url.protocol === "https:" ? https : http;
    const req = transport.request(
      url,
      {
        method: "GET",
        headers: {
          "Icy-MetaData": "1",
          "User-Agent": userAgent,
          Accept: "*/*",
          // Some Icecast servers only reveal icy-metaint on a "clean" client.
          Connection: "close",
        },
      },
      (res) => {
        // Radio endpoints redirect constantly (regional CDN, load balancers).
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          // Hand the redirect target to a fresh attempt. Not `done()` — that
          // would settle this promise with null before the retry resolves.
          let next: string | null = null;
          try {
            next = new URL(res.headers.location, url).href;
          } catch {
            next = null;
          }
          settled = true;
          if (timer) clearTimeout(timer);
          req.destroy();
          if (!next) {
            resolve(null);
            return;
          }
          fetchStreamMetadata(next, options).then(resolve, () => resolve(null));
          return;
        }
        if (status !== 200) {
          res.resume();
          resolve(null);
          return;
        }

        const metaint = Number(res.headers["icy-metaint"] ?? 0);
        // No ICY support: nothing to read, and draining the stream would waste
        // bandwidth. Hang up immediately.
        if (!Number.isFinite(metaint) || metaint <= 0) {
          res.destroy();
          resolve(null);
          return;
        }

        let audioSkip = metaint;
        let metaLen = -1;
        let metaBuf: Buffer[] = [];
        let metaRead = 0;

        const onData = (chunk: Buffer) => {
          let offset = 0;
          while (offset < chunk.length) {
            if (audioSkip > 0) {
              const take = Math.min(audioSkip, chunk.length - offset);
              audioSkip -= take;
              offset += take;
              continue;
            }
            if (metaLen < 0) {
              metaLen = chunk[offset] * 16;
              offset++;
              if (metaLen === 0) {
                // Empty block; this station simply had no title to report.
                done(null);
                return;
              }
              metaBuf = [];
              metaRead = 0;
              continue;
            }
            const take = Math.min(metaLen - metaRead, chunk.length - offset);
            metaBuf.push(chunk.subarray(offset, offset + take));
            metaRead += take;
            offset += take;
            if (metaRead >= metaLen) {
              const raw = Buffer.concat(metaBuf).toString("utf8");
              done(parseIcyMetadata(raw));
              return;
            }
          }
        };

        res.on("data", onData);
        res.on("end", () => done(null));
        res.on("error", () => resolve(null));
      },
    );

    req.on("error", () => resolve(null));
    timer = setTimeout(() => done(null), timeoutMs);
    req.end();
  });
}
