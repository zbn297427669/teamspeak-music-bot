import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOCAL_GROUP,
  filterLocalStations,
  groupCounts,
  isLocalGroupTag,
  type GroupCount,
  type LocalStationLike,
} from "./radioFilter.js";

const station = (name: string, group?: string, album?: string): LocalStationLike => ({ name, group, album });

const GROUPS: GroupCount[] = [
  { name: "古典·轻音·治愈", count: 2 },
  { name: "舒缓流行·经典金曲", count: 1 },
  { name: DEFAULT_LOCAL_GROUP, count: 1 },
];

const STATIONS: LocalStationLike[] = [
  station("上海经典947音乐广播 FM94.7", "古典·轻音·治愈", "古典·轻音·治愈,上海"),
  station("Classical FM 97.7", "古典·轻音·治愈", "古典·轻音·治愈,台湾"),
  station("北京音乐广播 FM97.4", "舒缓流行·经典金曲", "舒缓流行·经典金曲,北京"),
  station("手写添加的 Jazz 台"),
];

const selection = (patch: Partial<{ tag: string; country: string; bitrateMin: number }> = {}) => ({
  tag: "",
  country: "",
  bitrateMin: 0,
  ...patch,
});

describe("isLocalGroupTag", () => {
  it("recognises one of the operator's own groups", () => {
    expect(isLocalGroupTag("古典·轻音·治愈", GROUPS)).toBe(true);
  });

  it("treats a directory tag as not local", () => {
    expect(isLocalGroupTag("jazz", GROUPS)).toBe(false);
  });

  it("treats empty as not local", () => {
    expect(isLocalGroupTag("  ", GROUPS)).toBe(false);
  });
});

describe("filterLocalStations", () => {
  it("returns every import when nothing is selected", () => {
    expect(filterLocalStations(STATIONS, selection(), GROUPS)).toHaveLength(4);
  });

  it("narrows to a single imported group", () => {
    const out = filterLocalStations(STATIONS, selection({ tag: "古典·轻音·治愈" }), GROUPS);
    expect(out.map((s) => s.name)).toEqual([
      "上海经典947音乐广播 FM94.7",
      "Classical FM 97.7",
    ]);
  });

  it("matches a directory tag against the import's own text", () => {
    const out = filterLocalStations(STATIONS, selection({ tag: "jazz" }), GROUPS);
    expect(out.map((s) => s.name)).toEqual(["手写添加的 Jazz 台"]);
  });

  it("matches the note column too", () => {
    const out = filterLocalStations(STATIONS, selection({ tag: "上海" }), GROUPS);
    expect(out.map((s) => s.name)).toEqual(["上海经典947音乐广播 FM94.7"]);
  });

  it("is case-insensitive", () => {
    const out = filterLocalStations(STATIONS, selection({ tag: "CLASSICAL" }), GROUPS);
    expect(out.map((s) => s.name)).toEqual(["Classical FM 97.7"]);
  });

  it("hides imports when a country facet is active", () => {
    expect(filterLocalStations(STATIONS, selection({ country: "China" }), GROUPS)).toEqual([]);
  });

  it("hides imports when a bitrate facet is active", () => {
    expect(filterLocalStations(STATIONS, selection({ bitrateMin: 128 }), GROUPS)).toEqual([]);
  });

  it("falls back to the default group for a row with no group", () => {
    const out = filterLocalStations(STATIONS, selection({ tag: DEFAULT_LOCAL_GROUP }), GROUPS);
    expect(out.map((s) => s.name)).toEqual(["手写添加的 Jazz 台"]);
  });

  it("returns an empty list rather than throwing when nothing matches", () => {
    expect(filterLocalStations(STATIONS, selection({ tag: "nope" }), GROUPS)).toEqual([]);
  });
});

describe("groupCounts", () => {
  it("re-counts headers after filtering", () => {
    const filtered = filterLocalStations(STATIONS, selection({ tag: "古典·轻音·治愈" }), GROUPS);
    expect(groupCounts(filtered, GROUPS)).toEqual([{ name: "古典·轻音·治愈", count: 2 }]);
  });

  it("drops groups that no longer have a match", () => {
    const filtered = filterLocalStations(STATIONS, selection({ tag: "jazz" }), GROUPS);
    expect(groupCounts(filtered, GROUPS)).toEqual([{ name: DEFAULT_LOCAL_GROUP, count: 1 }]);
  });

  it("keeps the store's group order rather than match order", () => {
    const out = groupCounts(STATIONS, GROUPS);
    expect(out.map((g) => g.name)).toEqual([
      "古典·轻音·治愈",
      "舒缓流行·经典金曲",
      DEFAULT_LOCAL_GROUP,
    ]);
  });
});
