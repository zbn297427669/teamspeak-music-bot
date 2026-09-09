import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatVersionStamp, resolveAppVersion } from "./version.js";

function writePkg(root: string, version: string) {
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "tsmusicbot", version }),
    "utf8",
  );
}

describe("resolveAppVersion", () => {
  it("falls back to package.json when no git/sync stamp", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tsmb-ver-"));
    writePkg(root, "9.9.9");
    const prev = process.env.TSMB_VERSION;
    delete process.env.TSMB_VERSION;
    delete process.env.TSMB_APP_VERSION;
    try {
      const info = resolveAppVersion(root);
      expect(info.packageVersion).toBe("9.9.9");
      expect(info.version).toBe("9.9.9");
      expect(info.source).toBe("package");
    } finally {
      if (prev !== undefined) process.env.TSMB_VERSION = prev;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("prefers TSMB_VERSION env override", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tsmb-ver-"));
    writePkg(root, "1.0.0");
    const prev = process.env.TSMB_VERSION;
    process.env.TSMB_VERSION = "custom-build";
    try {
      const info = resolveAppVersion(root);
      expect(info.version).toBe("custom-build");
      expect(info.source).toBe("env");
    } finally {
      if (prev === undefined) delete process.env.TSMB_VERSION;
      else process.env.TSMB_VERSION = prev;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses sync stamp commit when present", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tsmb-ver-"));
    writePkg(root, "1.2.3");
    fs.writeFileSync(
      path.join(root, ".tsmusicbot-synced-from-wsl"),
      "syncedAt=2026-09-09T00:00:00+08:00\nhead=abc1234\n",
      "utf8",
    );
    const prev = process.env.TSMB_VERSION;
    delete process.env.TSMB_VERSION;
    delete process.env.TSMB_APP_VERSION;
    try {
      const info = resolveAppVersion(root);
      expect(info.commit).toBe("abc1234");
      expect(info.syncedAt).toBe("2026-09-09T00:00:00+08:00");
      expect(info.version).toBe("1.2.3+abc1234");
      expect(info.source).toBe("sync-stamp");
    } finally {
      if (prev !== undefined) process.env.TSMB_VERSION = prev;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("formatVersionStamp is valid JSON", () => {
    const raw = formatVersionStamp({
      packageVersion: "0.1.0",
      commit: "deadbee",
      describe: "v1.0.0-1-gdeadbee",
      syncedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(JSON.parse(raw)).toEqual({
      packageVersion: "0.1.0",
      commit: "deadbee",
      describe: "v1.0.0-1-gdeadbee",
      syncedAt: "2026-01-01T00:00:00.000Z",
    });
  });
});
