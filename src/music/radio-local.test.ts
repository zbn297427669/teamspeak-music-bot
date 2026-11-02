import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_GROUP,
  LocalRadioStore,
  localStationId,
  parseM3u,
  splitNameAndNote,
  toRadioStation,
} from "./radio-local.js";
import type { Logger } from "../logger.js";

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => logger,
} as unknown as Logger;

const PLAYLIST = `#EXTM3U x-tvg-url=""
#EXTINF:-1 group-title="古典",上海经典947音乐广播 FM94.7 · 上海
http://example.com/a.m3u8
#EXTINF:-1 group-title="流行",北京音乐广播 FM97.4 · 北京
http://example.com/b.mp3
#EXTINF:-1,无分组电台
http://example.com/c.mp3
`;

describe("splitNameAndNote", () => {
  it("splits on the region dot", () => {
    expect(splitNameAndNote("上海经典947音乐广播 FM94.7 · 上海")).toEqual({
      name: "上海经典947音乐广播 FM94.7",
      note: "上海",
    });
  });

  it("splits a trailing FM frequency when there is no dot", () => {
    expect(splitNameAndNote("山东音乐广播 FM99.1")).toEqual({
      name: "山东音乐广播",
      note: "FM99.1",
    });
  });

  it("keeps a plain name whole", () => {
    expect(splitNameAndNote("清晨音乐台")).toEqual({ name: "清晨音乐台", note: "" });
  });
});

describe("parseM3u", () => {
  it("reads name, group and url from #EXTINF", () => {
    const { stations, skipped } = parseM3u(PLAYLIST);
    expect(skipped).toEqual([]);
    expect(stations).toHaveLength(3);
    expect(stations[0]).toMatchObject({
      name: "上海经典947音乐广播 FM94.7",
      url: "http://example.com/a.m3u8",
      group: "古典",
      note: "上海",
    });
  });

  it("falls back to the default group", () => {
    const { stations } = parseM3u(PLAYLIST);
    expect(stations[2].group).toBe(DEFAULT_GROUP);
  });

  it("keeps a bare URL list playable, naming stations by host", () => {
    const { stations } = parseM3u("http://host-one.example:8000/live.mp3");
    expect(stations).toEqual([
      { name: "host-one.example:8000", url: "http://host-one.example:8000/live.mp3", group: DEFAULT_GROUP, note: "" },
    ]);
  });

  it("reports non-http entries instead of importing them", () => {
    const { stations, skipped } = parseM3u(
      '#EXTINF:-1,坏地址\njavascript:alert(1)\n#EXTINF:-1,好地址\nhttps://ok.example/s\n',
    );
    expect(stations.map((s) => s.name)).toEqual(["好地址"]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({ line: 2, reason: "不是 http(s) 流地址" });
  });

  it("reports a dangling #EXTINF", () => {
    const { stations, skipped } = parseM3u("#EXTINF:-1,只有标题没有地址\n");
    expect(stations).toEqual([]);
    expect(skipped[0].reason).toBe("#EXTINF 之后没有流地址");
  });

  it("ignores unknown #EXTINF attributes and other directives", () => {
    const { stations } = parseM3u(
      '#EXTM3U\n#EXTGRP:x\n#EXTINF:-1 tvg-id="a" radio="true" group-title="新闻",台\nhttp://e.example/s\n',
    );
    expect(stations).toHaveLength(1);
    expect(stations[0].group).toBe("新闻");
  });

  it("reads tvg-logo as the station's cover", () => {
    const { stations } = parseM3u(
      '#EXTINF:-1 tvg-logo="https://img.example/a.png" group-title="古典",台\nhttp://e.example/s\n',
    );
    expect(stations[0].cover).toBe("https://img.example/a.png");
  });

  it("leaves the cover empty when the playlist has no tvg-logo", () => {
    const { stations } = parseM3u(PLAYLIST);
    expect(stations[0].cover).toBe("");
  });
});

describe("localStationId", () => {
  it("is stable per URL and ignores case/whitespace differences", () => {
    const a = localStationId("http://Example.com/Stream");
    expect(a).toBe(localStationId("  http://example.com/Stream  "));
  });

  it("is shaped like a UUID", () => {
    expect(localStationId("http://a.example/s")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("differs between URLs", () => {
    expect(localStationId("http://a.example/s")).not.toBe(localStationId("http://b.example/s"));
  });
});

describe("toRadioStation", () => {
  it("produces a record the provider can resolve without a directory lookup", () => {
    const station = toRadioStation({ name: "台", url: "http://e.example/s", group: "组", note: "FM1" });
    expect(station).toMatchObject({
      name: "台",
      url: "http://e.example/s",
      url_resolved: "http://e.example/s",
      group: "组",
      local: true,
    });
    expect(station.tags).toBe("组,FM1");
  });

  it("fills in curated artwork for a known stream", () => {
    const station = toRadioStation({
      name: "上海经典947",
      url: "http://rs.ajmide.com/r_10/10.m3u8",
      group: "古典",
      note: "",
    });
    expect(station.favicon).toMatch(/^https:\/\/pic\.qtfm\.cn\//);
  });

  it("lets the playlist's own tvg-logo win over the curated table", () => {
    const station = toRadioStation({
      name: "上海经典947",
      url: "http://rs.ajmide.com/r_10/10.m3u8",
      group: "古典",
      note: "",
      cover: "https://img.example/own.png",
    });
    expect(station.favicon).toBe("https://img.example/own.png");
  });

  it("leaves an unknown station without artwork rather than guessing", () => {
    const station = toRadioStation({ name: "某台", url: "http://unknown.example/s", group: "组", note: "" });
    expect(station.favicon).toBe("");
  });
});

describe("LocalRadioStore", () => {
  function withStore(fn: (store: LocalRadioStore, path: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), "local-radio-"));
    const path = join(dir, "local-radio.json");
    try {
      fn(new LocalRadioStore(path, logger), path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("starts empty when the file is absent", () => {
    withStore((store) => {
      expect(store.list()).toEqual([]);
      expect(store.groups()).toEqual([]);
    });
  });

  it("imports parsed rows and reports counts", () => {
    withStore((store, path) => {
      const { stations } = parseM3u(PLAYLIST);
      expect(store.import(stations)).toEqual({ added: 3, updated: 0, total: 3 });
      expect(store.list()).toHaveLength(3);

      const onDisk = JSON.parse(readFileSync(path, "utf8"));
      expect(onDisk.version).toBe(1);
      expect(onDisk.stations).toHaveLength(3);
      expect(store.groups()).toEqual([
        { name: "古典", count: 1 },
        { name: "流行", count: 1 },
        { name: DEFAULT_GROUP, count: 1 },
      ]);
    });
  });

  it("updates by URL on re-import rather than duplicating", () => {
    withStore((store) => {
      store.import([{ name: "旧名", url: "http://e.example/s", group: "A", note: "" }]);
      const first = store.list()[0].stationuuid;

      const result = store.import([{ name: "新名", url: "http://e.example/s", group: "B", note: "" }]);
      expect(result).toEqual({ added: 0, updated: 1, total: 1 });

      const [station] = store.list();
      expect(station.name).toBe("新名");
      expect(station.group).toBe("B");
      // Identity is preserved so anything holding the id (a queue entry, the
      // now-playing cache) keeps resolving.
      expect(station.stationuuid).toBe(first);
    });
  });

  it("never deletes stations an import does not mention", () => {
    withStore((store) => {
      store.import([{ name: "手工添加", url: "http://keep.example/s", group: "A", note: "" }]);
      store.import([{ name: "新导入", url: "http://new.example/s", group: "B", note: "" }]);
      expect(store.list().map((s) => s.name).sort()).toEqual(["手工添加", "新导入"]);
    });
  });

  it("keeps an existing cover when a re-import carries no tvg-logo", () => {
    withStore((store) => {
      store.import([{ name: "台", url: "http://e.example/s", group: "A", note: "" }]);
      const id = store.list()[0].stationuuid;
      store.setCover(id, "https://img.example/a.png");

      store.import([{ name: "台", url: "http://e.example/s", group: "A", note: "" }]);
      expect(store.list()[0].favicon).toBe("https://img.example/a.png");
    });
  });

  it("lets a tvg-logo in a re-import replace the stored cover", () => {
    withStore((store) => {
      store.import([{ name: "台", url: "http://e.example/s", group: "A", note: "" }]);
      store.setCover(store.list()[0].stationuuid, "https://img.example/old.png");

      store.import([{ name: "台", url: "http://e.example/s", group: "A", note: "", cover: "https://img.example/new.png" }]);
      expect(store.list()[0].favicon).toBe("https://img.example/new.png");
    });
  });

  it("sets and clears a cover by id", () => {
    withStore((store) => {
      store.import(parseM3u(PLAYLIST).stations);
      const id = store.list()[0].stationuuid;

      expect(store.setCover(id, "https://img.example/x.png")).toBe(true);
      expect(store.find(id)?.favicon).toBe("https://img.example/x.png");

      expect(store.setCover(id, "")).toBe(true);
      expect(store.find(id)?.favicon).toBe("");

      expect(store.setCover("missing", "https://img.example/x.png")).toBe(false);
    });
  });

  it("removes by id and clears", () => {
    withStore((store) => {
      store.import(parseM3u(PLAYLIST).stations);
      const id = store.list()[0].stationuuid;

      expect(store.remove("nope")).toBe(false);
      expect(store.remove(id)).toBe(true);
      expect(store.list()).toHaveLength(2);
      expect(store.clear()).toBe(2);
      expect(store.list()).toEqual([]);
    });
  });

  it("finds a station by id", () => {
    withStore((store) => {
      store.import(parseM3u(PLAYLIST).stations);
      const id = store.list()[1].stationuuid;
      expect(store.find(id)?.name).toBe("北京音乐广播 FM97.4");
      expect(store.find("missing")).toBeNull();
    });
  });

  it("drops rows with an unplayable URL that were hand-edited into the file", () => {
    withStore((store, path) => {
      store.import(parseM3u(PLAYLIST).stations);
      const doc = JSON.parse(readFileSync(path, "utf8"));
      doc.stations.push({ stationuuid: "x", name: "bad", url: "file:///etc/passwd", group: "A" });
      writeFileSync(path, JSON.stringify(doc));

      const names = store.list().map((s) => s.name);
      expect(names).not.toContain("bad");
      expect(names).toHaveLength(3);
    });
  });

  it("treats a corrupt file as empty instead of throwing", () => {
    withStore((store, path) => {
      writeFileSync(path, "{ not json");
      expect(store.list()).toEqual([]);
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  it("writes atomically, leaving no .tmp behind", () => {
    withStore((store, path) => {
      store.import(parseM3u(PLAYLIST).stations);
      expect(() => readFileSync(`${path}.tmp`)).toThrow();
    });
  });

  /** A directory record as the starred-only path receives it. */
  const directoryStation = {
    stationuuid: "uuid-dir-1",
    name: "北京音乐广播",
    url: "http://stream.example/bj.mp3",
    url_resolved: "http://stream.example/bj.mp3",
    homepage: "",
    favicon: "https://img.example/bj.jpg",
    tags: "music",
    country: "China",
    countrycode: "CN",
    state: "",
    language: "",
    codec: "MP3",
    bitrate: 128,
    votes: 10,
  };

  it("stars an import in place instead of duplicating the row", () => {
    withStore((store) => {
      store.import(parseM3u(PLAYLIST).stations);
      const row = store.list()[0];

      expect(store.setFavorite(row, true)).toEqual({ favorited: true, created: false });
      expect(store.list()).toHaveLength(3);
      expect(store.favorites().map((s) => s.stationuuid)).toEqual([row.stationuuid]);
      // Still an import: 我的电台 shows it, now with a star.
      expect(store.imports()).toHaveLength(3);
      expect(store.list()[0].favorite).toBe(true);
      expect(store.list()[0].favoritedAt).toBeTruthy();

      store.setFavorite(row, false);
      expect(store.list()).toHaveLength(3);
      expect(store.favorites()).toEqual([]);
      expect(store.list()[0].favoritedAt).toBeUndefined();
    });
  });

  it("stores a starred directory station outside 我的电台", () => {
    withStore((store) => {
      expect(store.setFavorite(directoryStation, true)).toEqual({ favorited: true, created: true });

      expect(store.imports()).toEqual([]);
      expect(store.groups()).toEqual([]);
      expect(store.favorites()[0]).toMatchObject({
        stationuuid: "uuid-dir-1",
        name: "北京音乐广播",
        imported: false,
        favorite: true,
      });
    });
  });

  it("drops a starred-only row when it is unstarred", () => {
    withStore((store) => {
      store.setFavorite(directoryStation, true);
      store.setFavorite(directoryStation, false);
      expect(store.list()).toEqual([]);
    });
  });

  it("promotes a starred-only row to an import when the same stream is imported", () => {
    withStore((store) => {
      store.setFavorite(directoryStation, true);
      store.import([{ name: "北京台", url: directoryStation.url, group: "新闻", note: "" }]);

      expect(store.list()).toHaveLength(1);
      expect(store.list()[0]).toMatchObject({
        name: "北京台",
        group: "新闻",
        imported: true,
        favorite: true,
      });
      expect(store.groups()).toEqual([{ name: "新闻", count: 1 }]);
      expect(store.favorites()).toHaveLength(1);
    });
  });

  it("lists the most recently starred favorite first", () => {
    withStore((store) => {
      store.import([
        { name: "A", url: "http://a.example/s", group: "g", note: "" },
        { name: "B", url: "http://b.example/s", group: "g", note: "" },
      ]);
      const [a, b] = store.list();

      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
        store.setFavorite(a, true);
        vi.setSystemTime(new Date("2026-02-01T00:00:00Z"));
        store.setFavorite(b, true);
      } finally {
        vi.useRealTimers();
      }

      expect(store.favorites().map((s) => s.name)).toEqual(["B", "A"]);
    });
  });
});
