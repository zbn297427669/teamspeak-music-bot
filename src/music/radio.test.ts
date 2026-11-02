import { describe, expect, it, vi } from "vitest";
import {
  RadioProvider,
  isBlockedStreamHost,
  isImportableStreamUrl,
  isPlayableStreamUrl,
  mapStationToSong,
  stationStreamUrl,
  type RadioStation,
} from "./radio.js";
import type { Logger } from "../logger.js";

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => logger,
} as unknown as Logger;

function station(over: Partial<RadioStation> = {}): RadioStation {
  return {
    stationuuid: "uuid-1",
    name: "ChillHop Radio",
    url: "http://example.com/stream",
    url_resolved: "http://cdn.example.com/stream",
    homepage: "",
    favicon: "http://example.com/icon.png",
    tags: "chillhop,lo-fi",
    country: "Germany",
    countrycode: "DE",
    state: "",
    language: "german",
    codec: "MP3",
    bitrate: 320,
    votes: 10,
    ...over,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("isPlayableStreamUrl", () => {
  it("accepts http and https", () => {
    expect(isPlayableStreamUrl("http://a.example/s")).toBe(true);
    expect(isPlayableStreamUrl("https://a.example/s")).toBe(true);
  });

  it("rejects non-http schemes and junk", () => {
    expect(isPlayableStreamUrl("javascript:alert(1)")).toBe(false);
    expect(isPlayableStreamUrl("file:///etc/passwd")).toBe(false);
    expect(isPlayableStreamUrl("ftp://a.example/s")).toBe(false);
    expect(isPlayableStreamUrl("")).toBe(false);
    expect(isPlayableStreamUrl(undefined as unknown as string)).toBe(false);
    expect(isPlayableStreamUrl("not a url")).toBe(false);
  });
});

describe("isImportableStreamUrl", () => {
  it("accepts ordinary public stations", () => {
    for (const url of [
      "http://stream.example/s",
      "https://ice.example.org:8000/live.mp3",
      "http://59.120.88.155:8000/live.mp3",
    ]) {
      expect(isImportableStreamUrl(url)).toBe(true);
    }
  });

  it("refuses loopback, unspecified and mDNS names", () => {
    for (const url of [
      "http://localhost:3001/api/x",
      "http://LOCALHOST/stream",
      "http://app.localhost/stream",
      "http://127.0.0.1/live.mp3",
      "http://127.1.2.3/live.mp3",
      "http://0.0.0.0/live.mp3",
      "http://[::1]/live.mp3",
    ]) {
      expect(isImportableStreamUrl(url), url).toBe(false);
    }
  });

  it("refuses private, link-local and CGNAT ranges", () => {
    for (const url of [
      "http://10.0.0.5/live",
      "http://192.168.1.10:8080/live",
      "http://172.16.0.1/live",
      "http://172.31.255.255/live",
      "http://169.254.169.254/latest/meta-data/",
      "http://100.64.0.1/live",
    ]) {
      expect(isImportableStreamUrl(url), url).toBe(false);
    }
  });

  it("still allows addresses adjacent to the private ranges", () => {
    for (const url of [
      "http://172.15.0.1/live", // just below 172.16/12
      "http://172.32.0.1/live", // just above
      "http://192.169.0.1/live",
      "http://100.63.0.1/live",
      "http://100.128.0.1/live",
      "http://11.0.0.1/live",
    ]) {
      expect(isImportableStreamUrl(url), url).toBe(true);
    }
  });

  it("refuses non-http schemes before looking at the host", () => {
    expect(isImportableStreamUrl("file:///etc/passwd")).toBe(false);
    expect(isImportableStreamUrl("javascript:alert(1)")).toBe(false);
    expect(isImportableStreamUrl("")).toBe(false);
  });
});

describe("isBlockedStreamHost", () => {
  it("handles IPv6 unique-local and link-local prefixes", () => {
    expect(isBlockedStreamHost("fd00::1")).toBe(true);
    expect(isBlockedStreamHost("fc00::1")).toBe(true);
    expect(isBlockedStreamHost("fe80::1")).toBe(true);
    expect(isBlockedStreamHost("2001:db8::1")).toBe(false);
  });
});

describe("stationStreamUrl", () => {
  it("prefers the resolved URL", () => {
    expect(stationStreamUrl(station())).toBe("http://cdn.example.com/stream");
  });

  it("falls back to the raw URL when resolved is blank", () => {
    expect(stationStreamUrl(station({ url_resolved: "" }))).toBe(
      "http://example.com/stream",
    );
  });

  it("falls back when the resolved URL is not http(s)", () => {
    expect(
      stationStreamUrl(station({ url_resolved: "javascript:bad()" })),
    ).toBe("http://example.com/stream");
  });

  it("returns empty when neither URL is usable", () => {
    expect(
      stationStreamUrl(station({ url: "javascript:x()", url_resolved: "junk" })),
    ).toBe("");
  });
});

describe("mapStationToSong", () => {
  it("produces a live song with no duration", () => {
    const song = mapStationToSong(station());
    expect(song).toMatchObject({
      id: "uuid-1",
      name: "ChillHop Radio",
      platform: "radio",
      live: true,
      duration: 0,
      artist: "Germany",
      album: "chillhop,lo-fi",
      coverUrl: "http://example.com/icon.png",
    });
  });

  it("falls back to language, then a generic label, for artist", () => {
    expect(mapStationToSong(station({ country: "" })).artist).toBe("german");
    expect(
      mapStationToSong(station({ country: "", language: "" })).artist,
    ).toBe("网络电台");
  });

  it("never yields an empty name", () => {
    expect(mapStationToSong(station({ name: "  " })).name).toBe(
      "Unknown station",
    );
  });
});

describe("RadioProvider", () => {
  it("drops stations whose URLs are unusable", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse([
        station({ stationuuid: "ok" }),
        station({ stationuuid: "bad", url: "javascript:x", url_resolved: "" }),
      ]),
    );
    const p = new RadioProvider({ logger, fetchImpl: fetchImpl as unknown as typeof fetch });
    const songs = await p.search("chill", 10);
    expect(songs.songs.map((s) => s.id)).toEqual(["ok"]);
  });

  it("returns nothing for an empty search term (no criteria)", async () => {
    const fetchImpl = vi.fn();
    const p = new RadioProvider({ logger, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect((await p.search("   ", 10)).songs).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps parameters onto the directory query", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([station()]));
    const p = new RadioProvider({ logger, fetchImpl: fetchImpl as unknown as typeof fetch });
    await p.searchStations({
      name: "jazz",
      country: "France",
      tags: ["jazz", "swing"],
      bitrateMin: 128,
      limit: 5,
    });
    const url = String((fetchImpl.mock.calls[0] as unknown[])[0]);
    expect(url).toContain("/json/stations/search?");
    expect(url).toContain("name=jazz");
    expect(url).toContain("country=France");
    expect(url).toContain("tagList=jazz%2Cswing");
    expect(url).toContain("bitrateMin=128");
    expect(url).toContain("limit=5");
    expect(url).toContain("hidebroken=true");
  });

  it("falls through to the next mirror when one fails", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce(jsonResponse([station()]));
    const p = new RadioProvider({
      logger,
      mirrors: ["https://dead.example", "https://live.example"],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const songs = await p.search("chill", 5);
    expect(songs.songs).toHaveLength(1);
    expect(String((fetchImpl.mock.calls[1] as unknown[])[0])).toContain(
      "live.example",
    );
  });

  it("surfaces the last mirror error when every mirror fails", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("all down");
    });
    const p = new RadioProvider({
      logger,
      mirrors: ["https://a.example", "https://b.example"],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(p.search("x", 5)).rejects.toThrow("all down");
  });

  it("caches repeated searches", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([station()]));
    const p = new RadioProvider({ logger, fetchImpl: fetchImpl as unknown as typeof fetch });
    await p.search("chill", 5);
    await p.search("chill", 5);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("getSongUrl returns the playable stream URL", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([station()]));
    const p = new RadioProvider({ logger, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await p.getSongUrl("uuid-1")).toEqual({
      url: "http://cdn.example.com/stream",
    });
  });

  it("getSongUrl returns null for an unusable station", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse([station({ url: "javascript:x", url_resolved: "" })]),
    );
    const p = new RadioProvider({ logger, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await p.getSongUrl("uuid-1")).toBeNull();
  });

  it("getPersonalFm returns live songs", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse([station({ stationuuid: "a" }), station({ stationuuid: "b" })]),
    );
    const p = new RadioProvider({ logger, fetchImpl: fetchImpl as unknown as typeof fetch });
    const songs = await p.getPersonalFm();
    expect(songs).toHaveLength(2);
    expect(songs.every((s) => s.live === true)).toBe(true);
  });

  it("reports the platform as radio", () => {
    const p = new RadioProvider({ logger });
    expect(p.platform).toBe("radio");
  });
});

describe("RadioProvider with locally imported stations", () => {
  function localSource(rows: Array<{ id: string; name: string; url: string; group?: string; tags?: string }>) {
    const stations = rows.map((r) => ({
      stationuuid: r.id,
      name: r.name,
      url: r.url,
      url_resolved: r.url,
      homepage: "",
      favicon: "",
      tags: r.tags ?? "",
      country: "",
      countrycode: "",
      state: "",
      language: "",
      codec: "",
      bitrate: 0,
      votes: 0,
      group: r.group ?? "本地导入",
      local: true as const,
    }));
    return {
      list: () => stations,
      find: (id: string) => stations.find((s) => s.stationuuid === id) ?? null,
    };
  }

  it("resolves an imported station without touching the directory", async () => {
    const fetchImpl = vi.fn();
    const p = new RadioProvider({
      logger,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      localStations: localSource([{ id: "local-1", name: "我的台", url: "http://local.example/s" }]),
    });
    expect(await p.getSongUrl("local-1")).toEqual({ url: "http://local.example/s" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("falls through to the directory for an unknown id", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([station()]));
    const p = new RadioProvider({
      logger,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      localStations: localSource([{ id: "local-1", name: "我的台", url: "http://local.example/s" }]),
    });
    expect(await p.getSongUrl("uuid-1")).toEqual({ url: "http://cdn.example.com/stream" });
  });

  it("lists imported stations as live songs", () => {
    const p = new RadioProvider({
      logger,
      localStations: localSource([
        { id: "a", name: "台 A", url: "http://a.example/s" },
        { id: "b", name: "台 B", url: "http://b.example/s" },
      ]),
    });
    const listed = p.listLocalStations();
    expect(listed).toHaveLength(2);
    expect(listed[0].local).toBe(true);
  });

  it("puts local matches first in search", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([station({ name: "ChillHop Directory" })]));
    const p = new RadioProvider({
      logger,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      localStations: localSource([{ id: "local-1", name: "ChillHop 本地", url: "http://local.example/s" }]),
    });
    const result = await p.search("chill");
    expect(result.songs[0].name).toBe("ChillHop 本地");
    expect(result.songs.some((s) => s.name === "ChillHop Directory")).toBe(true);
  });

  it("searchLocalStations matches name, group and note", () => {
    const p = new RadioProvider({
      logger,
      localStations: localSource([
        { id: "a", name: "古典台", url: "http://a.example/s", group: "古典", tags: "古典,FM94.7" },
        { id: "b", name: "流行台", url: "http://b.example/s", group: "流行" },
      ]),
    });
    expect(p.searchLocalStations("吉他").length).toBe(0);
    expect(p.searchLocalStations("古典").map((s) => s.stationuuid)).toEqual(["a"]);
    expect(p.searchLocalStations("").length).toBe(2);
  });

  it("mixes imported stations into personal FM", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([]));
    const p = new RadioProvider({
      logger,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      localStations: localSource([{ id: "local-1", name: "我的台", url: "http://local.example/s" }]),
    });
    const songs = await p.getPersonalFm();
    expect(songs.map((s) => s.name)).toContain("我的台");
    expect(songs.every((s) => s.live === true)).toBe(true);
  });
});
