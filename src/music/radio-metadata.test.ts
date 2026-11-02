import { describe, expect, it } from "vitest";
import { parseIcyMetadata, splitArtistTitle } from "./radio-metadata.js";

describe("splitArtistTitle", () => {
  it("splits on the first ' - '", () => {
    expect(splitArtistTitle("Miles Davis - So What")).toEqual({
      artist: "Miles Davis",
      song: "So What",
    });
  });

  it("keeps ' - ' inside the song title", () => {
    expect(splitArtistTitle("A - B - C")).toEqual({ artist: "A", song: "B - C" });
  });

  it("treats a separator-less title as the song", () => {
    expect(splitArtistTitle("Morning News")).toEqual({
      artist: "",
      song: "Morning News",
    });
  });

  it("does not split when the separator is at index 0", () => {
    expect(splitArtistTitle(" - Leading")).toEqual({
      artist: "",
      song: " - Leading",
    });
  });
});

describe("parseIcyMetadata", () => {
  it("parses the standard StreamTitle form", () => {
    expect(parseIcyMetadata("StreamTitle='Artist - Song';")).toEqual({
      title: "Artist - Song",
      artist: "Artist",
      song: "Song",
    });
  });

  it("strips NUL padding", () => {
    expect(parseIcyMetadata("StreamTitle='A - B';\0\0\0")?.title).toBe("A - B");
  });

  it("unescapes backslash escapes", () => {
    expect(parseIcyMetadata("StreamTitle='Don\\'t Stop';")?.title).toBe(
      "Don't Stop",
    );
  });

  it("parses the iHeartRadio Exploring form", () => {
    expect(
      parseIcyMetadata('Exploring title="So What",artist="Miles Davis",url="x"'),
    ).toEqual({
      title: "Miles Davis - So What",
      artist: "Miles Davis",
      song: "So What",
    });
  });

  it("parses attributes embedded inside StreamTitle", () => {
    const raw = 'StreamTitle=\'Miles - text="So What" amgArtworkURL="http://x"\'';
    const meta = parseIcyMetadata(raw);
    expect(meta?.song).toBe("So What");
    expect(meta?.artist).toBe("Miles");
  });

  it("returns null for empty or title-less payloads", () => {
    expect(parseIcyMetadata("")).toBeNull();
    expect(parseIcyMetadata("\0\0\0")).toBeNull();
    expect(parseIcyMetadata("StreamUrl='http://x';")).toBeNull();
  });

  it("returns null for an empty StreamTitle", () => {
    expect(parseIcyMetadata("StreamTitle='';")).toBeNull();
  });

  it("handles a talk station with no artist separator", () => {
    expect(parseIcyMetadata("StreamTitle='Morning News';")).toEqual({
      title: "Morning News",
      artist: "",
      song: "Morning News",
    });
  });
});
