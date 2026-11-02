import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import pino from "pino";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultConfig } from "../../data/config.js";
import { LocalRadioStore } from "../../music/radio-local.js";
import { RadioProvider } from "../../music/radio.js";
import { createRadioRouter } from "./radio.js";

/**
 * Station reachability + favorites.
 *
 * The probe is the part that touches the network, so every test injects a
 * `fetch` double: nothing here opens a socket to a real station or to the
 * directory.
 */
describe("radio station status", () => {
  let dir: string;
  let store: LocalRadioStore;

  const config = { ...getDefaultConfig(), enabledProviders: ["radio" as const] };
  const logger = pino({ level: "silent" });

  /** A response that behaves like a live stream: 2xx with a readable body. */
  function streamResponse(chunks: Uint8Array[] = [new Uint8Array([1, 2, 3])]) {
    let i = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i < chunks.length) controller.enqueue(chunks[i++]);
        else controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "audio/mpeg" } });
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "radio-status-"));
    store = new LocalRadioStore(join(dir, "local-radio.json"), logger);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function appWith(fetchImpl: typeof fetch, opts: { user?: unknown } = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).user = opts.user ?? { id: "u1", username: "alice", role: "member" };
      next();
    });
    app.use("/api/radio", createRadioRouter(
      // localStations must be wired: imported stations are resolved from disk,
      // so without it every import id falls through to the (mocked) directory
      // and comes back as "no URL".
      new RadioProvider({
        logger,
        localStations: store,
        fetchImpl: vi.fn(async () => new Response("[]", { status: 200 })),
      }),
      logger,
      config,
      { localStore: store, fetchImpl },
    ));
    return app;
  }

  it("passes codec and bitrate through so the card can show a detail line", async () => {
    const record = {
      stationuuid: "uuid-1",
      name: "某目录台",
      url: "http://stream.example/dir.mp3",
      url_resolved: "http://stream.example/dir.mp3",
      homepage: "",
      favicon: "",
      tags: "jazz,chill",
      country: "China",
      countrycode: "CN",
      state: "",
      language: "",
      codec: "MP3",
      bitrate: 192,
      votes: 1,
    };
    const app = express();
    app.use((req, _res, next) => {
      (req as any).user = { id: "u1", role: "member" };
      next();
    });
    app.use("/api/radio", createRadioRouter(
      new RadioProvider({
        logger,
        fetchImpl: vi.fn(async () => new Response(JSON.stringify([record]), {
          status: 200,
          headers: { "content-type": "application/json" },
        })),
      }),
      logger,
      config,
    ));

    const res = await request(app).get("/api/radio/stations?limit=1");

    expect(res.status).toBe(200);
    expect(res.body.stations[0]).toMatchObject({
      id: "uuid-1",
      name: "某目录台",
      album: "jazz,chill",
      codec: "MP3",
      bitrate: 192,
    });
  });

  it("reports a station that answers with audio as online", async () => {
    store.import([{ name: "某台", url: "http://stream.example/live.mp3", group: "本地导入", note: "" }]);
    const id = store.list()[0].stationuuid;

    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => streamResponse());
    const res = await request(appWith(fetchImpl)).get(`/api/radio/status?id=${id}`);

    expect(res.status).toBe(200);
    const [st] = res.body.statuses;
    expect(st.id).toBe(id);
    expect(st.state).toBe("online");
    expect(st.online).toBe(true);
    expect(st.httpStatus).toBe(200);
    // The probe asks for a single byte and hangs up instead of downloading.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1]?.headers).toMatchObject({ Range: "bytes=0-0" });
  });

  it("reports an HTTP error response as offline, not unknown", async () => {
    store.import([{ name: "某台", url: "http://stream.example/live.mp3", group: "本地导入", note: "" }]);
    const id = store.list()[0].stationuuid;

    const res = await request(appWith(vi.fn(async () => new Response("gone", { status: 410 }))))
      .get(`/api/radio/status?id=${id}`);

    expect(res.body.statuses[0].state).toBe("offline");
    expect(res.body.statuses[0].httpStatus).toBe(410);
  });

  it("re-probes on refresh=1 instead of replaying the cached answer", async () => {
    store.import([{ name: "某台", url: "http://stream.example/live.mp3", group: "本地导入", note: "" }]);
    const id = store.list()[0].stationuuid;

    let online = true;
    const fetchImpl = vi.fn(async () =>
      online ? streamResponse() : new Response("gone", { status: 410 }));
    const app = appWith(fetchImpl);

    const first = await request(app).get(`/api/radio/status?id=${id}`);
    expect(first.body.statuses[0].state).toBe("online");
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Inside the 60s TTL the cached answer is served without dialling again.
    online = false;
    const cached = await request(app).get(`/api/radio/status?id=${id}`);
    expect(cached.body.statuses[0].state).toBe("online");
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // The page's manual button asks for refresh=1 and must see the new answer.
    const forced = await request(app).get(`/api/radio/status?id=${id}&refresh=1`);
    expect(forced.body.statuses[0].state).toBe("offline");
    expect(forced.body.statuses[0].httpStatus).toBe(410);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("treats a timeout as unknown rather than declaring the station dead", async () => {
    store.import([{ name: "某台", url: "http://slow.example/live.mp3", group: "本地导入", note: "" }]);
    const id = store.list()[0].stationuuid;

    const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    const res = await request(appWith(vi.fn(async () => { throw timeout; })))
      .get(`/api/radio/status?id=${id}`);

    // A flaky probe must never grey out a station the user could still play.
    expect(res.body.statuses[0].state).toBe("unknown");
    expect(res.body.statuses[0].online).toBe(false);
  });

  it("marks a station offline when its stored URL is not playable", async () => {
    store.import([{ name: "某台", url: "http://stream.example/ok.mp3", group: "本地导入", note: "" }]);
    const id = store.list()[0].stationuuid;
    // Hand-edit the file the way an operator would: the store's read path
    // allows a private host, and the probe must still refuse to dial it.
    const file = JSON.parse(require("node:fs").readFileSync(store.filePath, "utf8"));
    file.stations[0].url = "file:///etc/passwd";
    require("node:fs").writeFileSync(store.filePath, JSON.stringify(file));

    const fetchImpl = vi.fn(async () => streamResponse());
    const res = await request(appWith(fetchImpl)).get(`/api/radio/status?id=${id}`);

    expect(res.body.statuses[0].state).toBe("offline");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reuses a probe result within the cache window", async () => {
    store.import([{ name: "某台", url: "http://stream.example/live.mp3", group: "本地导入", note: "" }]);
    const id = store.list()[0].stationuuid;
    const fetchImpl = vi.fn(async () => streamResponse());
    const app = appWith(fetchImpl);

    await request(app).get(`/api/radio/status?id=${id}`);
    const second = await request(app).get(`/api/radio/status?id=${id}`);

    expect(second.body.statuses[0].state).toBe("online");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects a request that names no station", async () => {
    const res = await request(appWith(vi.fn())).get("/api/radio/status");
    expect(res.status).toBe(400);
  });

  it("is gated on the radio source switch", async () => {
    const off = { ...getDefaultConfig(), enabledProviders: [] };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).user = { id: "u1", role: "admin" };
      next();
    });
    app.use("/api/radio", createRadioRouter(
      new RadioProvider({ logger }),
      logger,
      off,
      { localStore: store, fetchImpl: vi.fn() },
    ));
    const res = await request(app).get("/api/radio/status?id=x");
    expect(res.status).toBe(403);
  });
});

describe("radio favorites", () => {
  let dir: string;
  let store: LocalRadioStore;

  const config = { ...getDefaultConfig(), enabledProviders: ["radio" as const] };
  const logger = pino({ level: "silent" });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "radio-fav-"));
    store = new LocalRadioStore(join(dir, "local-radio.json"), logger);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Directory record the mocked `byuuid` returns for `uuid-dir-1`. This is the
   *  production path for starring a browse result: the page only has the row it
   *  rendered, so the server resolves the stream URL from the directory. */
  const directoryRecord = {
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

  function appFor(role: "admin" | "member" | "guest") {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).user = { id: "u1", username: "alice", role, capabilities: new Set(), guest: {} };
      next();
    });
    app.use("/api/radio", createRadioRouter(
      new RadioProvider({
        logger,
        localStations: store,
        // Only the known station resolves; anything else is unknown to the
        // directory, which is what an import or a bogus id looks like.
        fetchImpl: vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input);
          const body = url.includes(`/stations/byuuid/${directoryRecord.stationuuid}`)
            ? JSON.stringify([directoryRecord])
            : "[]";
          return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
        }),
      }),
      logger,
      config,
      { localStore: store },
    ));
    return app;
  }

  const dirStation = {
    id: "uuid-dir-1",
    name: "北京音乐广播",
    artist: "China",
    album: "music",
    duration: 0,
    coverUrl: "https://img.example/bj.jpg",
    platform: "radio",
    live: true,
  };

  it("pins a directory station to the top, with its cover", async () => {
    const res = await request(appFor("member"))
      .post("/api/radio/favorites")
      .send({ station: dirStation, favorite: true });

    expect(res.status).toBe(200);
    expect(res.body.favorites).toHaveLength(1);
    expect(res.body.favorites[0].id).toBe("uuid-dir-1");
    expect(res.body.favorites[0].coverUrl).toBe("https://img.example/bj.jpg");
    // Persisted with the real station identity so it survives a directory
    // outage and can still be resolved later.
    expect(store.favorites()[0].stationuuid).toBe("uuid-dir-1");
  });

  it("favorites an imported station without duplicating the row", async () => {
    store.import([{ name: "某台", url: "http://stream.example/a.mp3", group: "古典", note: "" }]);
    const mixed = { ...dirStation, id: store.list()[0].stationuuid, name: "某台" };

    await request(appFor("member")).post("/api/radio/favorites").send({ station: mixed, favorite: true });

    expect(store.list()).toHaveLength(1); // still one row, now flagged
    expect(store.list()[0].favorite).toBe(true);
    expect(store.list()[0].group).toBe("古典"); // import metadata untouched
  });

  it("unstars without deleting the station", async () => {
    store.import([{ name: "某台", url: "http://stream.example/a.mp3", group: "古典", note: "" }]);
    const mixed = { ...dirStation, id: store.list()[0].stationuuid, name: "某台" };
    const app = appFor("member");

    await request(app).post("/api/radio/favorites").send({ station: mixed, favorite: true });
    const off = await request(app).post("/api/radio/favorites").send({ station: mixed, favorite: false });

    expect(off.body.favorites).toHaveLength(0);
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0].favorite).toBe(false);
  });

  it("refuses to favorite a private address", async () => {
    const res = await request(appFor("member"))
      .post("/api/radio/favorites")
      .send({ station: { ...dirStation, id: "x", name: "内网", coverUrl: "" }, favorite: true });
    // The favicon-less row has no resolvable URL, so it cannot be stored.
    expect(res.status).toBe(400);
    expect(store.list()).toHaveLength(0);
  });

  it("keeps guests out of the shared list", async () => {
    const res = await request(appFor("guest"))
      .post("/api/radio/favorites")
      .send({ station: dirStation, favorite: true });
    expect(res.status).toBe(403);
  });

  it("rejects a request without a station", async () => {
    const res = await request(appFor("member")).post("/api/radio/favorites").send({});
    expect(res.status).toBe(400);
  });

  it("serves the pinned list over GET /favorites", async () => {
    const app = appFor("member");
    const empty = await request(app).get("/api/radio/favorites");
    expect(empty.status).toBe(200);
    expect(empty.body.favorites).toEqual([]);

    await request(app).post("/api/radio/favorites").send({ station: dirStation, favorite: true });
    const res = await request(app).get("/api/radio/favorites");
    expect(res.body.favorites).toHaveLength(1);
    expect(res.body.favorites[0]).toMatchObject({
      id: "uuid-dir-1",
      favorite: true,
      // Starred from the directory, not imported: the card must not claim 本地.
      local: false,
    });
  });

  it("keeps a starred directory station out of 我的电台", async () => {
    const app = appFor("member");
    await request(app).post("/api/radio/favorites").send({ station: dirStation, favorite: true });

    const local = await request(app).get("/api/radio/local");
    expect(local.body.stations).toEqual([]);
    // Its FAVORITE_GROUP would otherwise appear in the group dropdown.
    expect(local.body.groups).toEqual([]);
  });

  it("marks a favorited import in 我的电台 instead of hiding it", async () => {
    store.import([{ name: "某台", url: "http://stream.example/a.mp3", group: "古典", note: "" }]);
    const mixed = { ...dirStation, id: store.list()[0].stationuuid, name: "某台" };
    const app = appFor("member");

    await request(app).post("/api/radio/favorites").send({ station: mixed, favorite: true });
    const local = await request(app).get("/api/radio/local");

    expect(local.body.stations).toHaveLength(1);
    expect(local.body.stations[0]).toMatchObject({
      name: "某台",
      group: "古典",
      local: true,
      favorite: true,
    });
    expect(local.body.groups).toEqual([{ name: "古典", count: 1 }]);
  });

  it("removes the stored row once a starred-only station is unstarred", async () => {
    const app = appFor("member");
    await request(app).post("/api/radio/favorites").send({ station: dirStation, favorite: true });
    await request(app).post("/api/radio/favorites").send({ station: dirStation, favorite: false });

    expect(store.list()).toEqual([]);
  });
});
