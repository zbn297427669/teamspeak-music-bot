import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import pino from "pino";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultConfig } from "../../data/config.js";
import { LocalRadioStore } from "../../music/radio-local.js";
import { RadioProvider } from "../../music/radio.js";
import { createRadioRouter } from "./radio.js";

/**
 * Cover art on locally imported stations.
 *
 * The page renders `song.coverUrl`, which the provider fills from the
 * station's `favicon`. These tests pin the three ways that value gets set:
 * a playlist's `tvg-logo`, the `cover` field on a single-URL import, and the
 * explicit PUT used to repair a station after the fact.
 */
describe("radio cover art", () => {
  let dir: string;
  let store: LocalRadioStore;
  let app: express.Express;

  const config = { ...getDefaultConfig(), enabledProviders: ["radio" as const] };
  const logger = pino({ level: "silent" });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "radio-cover-"));
    store = new LocalRadioStore(join(dir, "local-radio.json"), logger);
    app = express();
    app.use(express.json());
    // Stand-in for the global requireAuth: the mutation routes require
    // bot.manage, so every request here arrives as an admin unless a test
    // overrides the user (see the authorization block below).
    app.use((req, _res, next) => {
      (req as any).user = { id: "u1", username: "admin", role: "admin" };
      next();
    });
    // The router needs a provider instance to consider radio "on"; the cover
    // routes never touch the directory, so a stub is enough.
    app.use("/api/radio", createRadioRouter(
      new RadioProvider({ logger }),
      logger,
      config,
      { localStore: store },
    ));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("carries tvg-logo from the playlist through to coverUrl", async () => {
    const playlist = [
      '#EXTM3U',
      '#EXTINF:-1 tvg-logo="https://img.example/a.png" group-title="古典",上海经典947 FM94.7',
      'http://stream.example/a.m3u8',
    ].join("\n");

    const res = await request(app).post("/api/radio/local/import").send({ playlist });
    expect(res.status).toBe(200);
    expect(res.body.added).toBe(1);

    const list = await request(app).get("/api/radio/local");
    expect(list.body.stations[0].coverUrl).toBe("https://img.example/a.png");
  });

  it("uses the cover supplied with a single-URL import", async () => {
    await request(app)
      .post("/api/radio/local/import")
      .send({ url: "http://stream.example/b.mp3", name: "某台", cover: "https://img.example/b.png" });

    const list = await request(app).get("/api/radio/local");
    expect(list.body.stations[0].coverUrl).toBe("https://img.example/b.png");
  });

  it("rejects a non-http cover instead of storing it", async () => {
    const res = await request(app)
      .post("/api/radio/local/import")
      .send({ url: "http://stream.example/c.mp3", cover: "javascript:alert(1)" });

    expect(res.status).toBe(400);
    expect(store.list()).toEqual([]);
  });

  it("sets and clears a cover through PUT /local/:id/cover", async () => {
    await request(app)
      .post("/api/radio/local/import")
      .send({ url: "http://stream.example/d.mp3", name: "某台" });
    const id = store.list()[0].stationuuid;

    const set = await request(app)
      .put(`/api/radio/local/${id}/cover`)
      .send({ cover: "https://img.example/d.png" });
    expect(set.status).toBe(200);
    expect(set.body.stations[0].coverUrl).toBe("https://img.example/d.png");

    const cleared = await request(app).put(`/api/radio/local/${id}/cover`).send({ cover: "" });
    expect(cleared.status).toBe(200);
    expect(cleared.body.stations[0].coverUrl).toBe("");
  });

  it("404s a cover change for an unknown station", async () => {
    const res = await request(app)
      .put("/api/radio/local/not-a-station/cover")
      .send({ cover: "https://img.example/x.png" });
    expect(res.status).toBe(404);
  });

  it("rejects a non-http cover on the PUT route", async () => {
    await request(app)
      .post("/api/radio/local/import")
      .send({ url: "http://stream.example/e.mp3" });
    const id = store.list()[0].stationuuid;

    const res = await request(app)
      .put(`/api/radio/local/${id}/cover`)
      .send({ cover: "file:///etc/passwd" });
    expect(res.status).toBe(400);
  });
});

describe("radio cover art — preview", () => {
  it("shows the cover a dry run would write", async () => {
    const dir = mkdtempSync(join(tmpdir(), "radio-cover-dry-"));
    const logger = pino({ level: "silent" });
    const store = new LocalRadioStore(join(dir, "local-radio.json"), logger);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).user = { id: "u1", username: "admin", role: "admin" };
      next();
    });
    app.use("/api/radio", createRadioRouter(
      new RadioProvider({ logger }),
      logger,
      { ...getDefaultConfig(), enabledProviders: ["radio" as const] },
      { localStore: store },
    ));

    const res = await request(app)
      .post("/api/radio/local/import")
      .send({ url: "http://stream.example/f.mp3", cover: "https://img.example/f.png", dryRun: true });

    expect(res.body.preview[0].cover).toBe("https://img.example/f.png");
    expect(store.list()).toEqual([]);

    rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * Imported stations are shared, operator-owned data, and an import picks the
 * address the *server* will dial. Both properties were previously unguarded:
 * the page's mutation routes were reachable by anyone with a session, and a
 * pasted playlist could point the bot at its own sidecars or the LAN.
 */
describe("radio local stations — authorization and import safety", () => {
  let dir: string;
  let store: LocalRadioStore;

  const config = { ...getDefaultConfig(), enabledProviders: ["radio" as const] };
  const logger = pino({ level: "silent" });

  function appFor(user: unknown): express.Express {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).user = user;
      next();
    });
    app.use("/api/radio", createRadioRouter(
      new RadioProvider({ logger }),
      logger,
      config,
      { localStore: store },
    ));
    return app;
  }

  const admin = { id: "a1", username: "admin", role: "admin" };
  const member = { id: "m1", username: "bob", role: "member", capabilities: new Set(["player.control", "player.queue"]) };
  const memberWithManage = { id: "m2", username: "carol", role: "member", capabilities: new Set(["bot.manage"]) };
  const guest = { id: "g1", username: "guest", role: "guest", guest: {} };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "radio-auth-"));
    store = new LocalRadioStore(join(dir, "local-radio.json"), logger);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("denies a guest every mutation route", async () => {
    const app = appFor(guest);
    const seeded = await request(appFor(admin))
      .post("/api/radio/local/import")
      .send({ url: "http://stream.example/a.mp3" });
    expect(seeded.status).toBe(200);
    const id = store.list()[0].stationuuid;

    expect((await request(app).post("/api/radio/local/import").send({ url: "http://stream.example/b.mp3" })).status)
      .toBe(403);
    expect((await request(app).put(`/api/radio/local/${id}/cover`).send({ cover: "" })).status).toBe(403);
    expect((await request(app).delete(`/api/radio/local/${id}`)).status).toBe(403);
    expect((await request(app).delete("/api/radio/local")).status).toBe(403);
    // …and nothing was changed by the attempts above.
    expect(store.list()).toHaveLength(1);
  });

  it("denies a member without bot.manage, but lets one with it through", async () => {
    const denied = appFor(member);
    expect((await request(denied).post("/api/radio/local/import").send({ url: "http://stream.example/c.mp3" })).status)
      .toBe(403);

    const allowed = appFor(memberWithManage);
    expect((await request(allowed).post("/api/radio/local/import").send({ url: "http://stream.example/c.mp3" })).status)
      .toBe(200);
    expect(store.list()).toHaveLength(1);
  });

  it("still lets every signed-in role read the station list", async () => {
    store.import([{ name: "某台", url: "http://stream.example/d.mp3", group: "本地导入", note: "" }]);
    for (const user of [admin, member, guest]) {
      const res = await request(appFor(user)).get("/api/radio/local");
      expect(res.status).toBe(200);
      expect(res.body.stations).toHaveLength(1);
    }
  });

  it("refuses a playlist entry that points at loopback or the LAN", async () => {
    const app = appFor(admin);
    const playlist = [
      "#EXTM3U",
      "#EXTINF:-1,本机 sidecar",
      "http://127.0.0.1:3001/api/search",
      "#EXTINF:-1,内网设备",
      "http://192.168.1.10:8080/stream.mp3",
      "#EXTINF:-1,云元数据",
      "http://169.254.169.254/latest/meta-data/",
      "#EXTINF:-1,正常电台",
      "http://stream.example/ok.mp3",
    ].join("\n");

    const res = await request(app).post("/api/radio/local/import").send({ playlist });
    expect(res.status).toBe(200);
    expect(res.body.added).toBe(1);
    expect(res.body.skipped).toHaveLength(3);
    expect(store.list().map((s: { url: string }) => s.url)).toEqual(["http://stream.example/ok.mp3"]);
  });

  it("refuses a single pasted URL on a private host", async () => {
    const app = appFor(admin);
    const res = await request(app)
      .post("/api/radio/local/import")
      .send({ url: "http://localhost:3200/stream" });
    expect(res.status).toBe(400);
    expect(store.list()).toEqual([]);
  });

  it("keeps playing a hand-edited private station (read path stays permissive)", () => {
    store.import([{ name: "内网台", url: "http://stream.example/lan.mp3", group: "本地导入", note: "" }]);
    const file = JSON.parse(readFileSync(store.filePath, "utf8"));
    file.stations[0].url = "http://192.168.1.20:8000/live.mp3";
    writeFileSync(store.filePath, JSON.stringify(file));

    expect(store.list().map((s) => s.url)).toEqual(["http://192.168.1.20:8000/live.mp3"]);
  });
});
