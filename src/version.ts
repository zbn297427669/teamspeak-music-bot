import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type AppVersionInfo = {
  /** Best string for UI / health.version (backward compatible). */
  version: string;
  /** package.json "version" field. */
  packageVersion: string;
  /** Short git SHA when known. */
  commit: string | null;
  /** `git describe --tags --always` when available. */
  gitDescribe: string | null;
  /** ISO time from last WSL→Windows sync stamp, if any. */
  syncedAt: string | null;
  /** Where the displayed version was resolved from. */
  source: "env" | "git" | "version-file" | "sync-stamp" | "package";
};

type VersionFile = {
  packageVersion?: string;
  commit?: string;
  describe?: string;
  syncedAt?: string;
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readPackageVersion(root = ROOT): string {
  try {
    const raw = fs.readFileSync(path.join(root, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version?.trim() || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function tryGit(args: string[], root = ROOT): string | null {
  try {
    const out = execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

function readJsonFile(filePath: string): VersionFile | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as VersionFile;
  } catch {
    return null;
  }
}

/** Parse `.tsmusicbot-synced-from-wsl` (KEY=value lines). */
function readSyncStamp(root = ROOT): { commit: string | null; syncedAt: string | null } {
  const filePath = path.join(root, ".tsmusicbot-synced-from-wsl");
  try {
    if (!fs.existsSync(filePath)) return { commit: null, syncedAt: null };
    const text = fs.readFileSync(filePath, "utf8");
    let commit: string | null = null;
    let syncedAt: string | null = null;
    for (const line of text.split(/\r?\n/)) {
      const m = /^([^=]+)=(.*)$/.exec(line.trim());
      if (!m) continue;
      if (m[1] === "head") commit = m[2].trim() || null;
      if (m[1] === "syncedAt") syncedAt = m[2].trim() || null;
    }
    return { commit, syncedAt };
  } catch {
    return { commit: null, syncedAt: null };
  }
}

function buildDisplay(parts: {
  envVersion?: string | null;
  gitDescribe?: string | null;
  packageVersion: string;
  commit?: string | null;
}): { version: string; source: AppVersionInfo["source"] } {
  const envVersion = parts.envVersion?.trim();
  if (envVersion) return { version: envVersion, source: "env" };

  const describe = parts.gitDescribe?.trim();
  if (describe) return { version: describe, source: "git" };

  const commit = parts.commit?.trim();
  if (commit) {
    return {
      version: `${parts.packageVersion}+${commit}`,
      source: "sync-stamp",
    };
  }

  return { version: parts.packageVersion, source: "package" };
}

/**
 * Resolve a human-friendly app version for /api/health and the WebUI.
 *
 * Priority:
 * 1. TSMB_VERSION / TSMB_APP_VERSION env (operator override)
 * 2. git describe --tags --always (dev / git checkout)
 * 3. .tsmusicbot-version.json (written by sync/deploy)
 * 4. .tsmusicbot-synced-from-wsl head= (WSL→Windows split deploy)
 * 5. package.json version alone
 */
export function resolveAppVersion(root = ROOT): AppVersionInfo {
  const packageVersion = readPackageVersion(root);
  const envVersion =
    process.env.TSMB_VERSION?.trim() || process.env.TSMB_APP_VERSION?.trim() || null;

  const gitDescribe = tryGit(["describe", "--tags", "--always", "--dirty"], root);
  const gitCommit = tryGit(["rev-parse", "--short", "HEAD"], root);

  const versionFile =
    readJsonFile(path.join(root, ".tsmusicbot-version.json")) ??
    readJsonFile(path.join(root, "data", ".tsmusicbot-version.json"));

  const syncStamp = readSyncStamp(root);

  const commit =
    gitCommit ||
    versionFile?.commit?.trim() ||
    syncStamp.commit ||
    null;

  const describe = gitDescribe || versionFile?.describe?.trim() || null;
  const syncedAt = versionFile?.syncedAt?.trim() || syncStamp.syncedAt || null;

  // If we only have version-file describe (no live git), credit version-file.
  let built = buildDisplay({
    envVersion,
    gitDescribe: describe,
    packageVersion: versionFile?.packageVersion?.trim() || packageVersion,
    commit,
  });

  if (built.source === "git" && !gitDescribe && versionFile?.describe) {
    built = { ...built, source: "version-file" };
  }
  if (built.source === "sync-stamp" && versionFile?.commit && !syncStamp.commit && !gitCommit) {
    built = { ...built, source: "version-file" };
  }

  return {
    version: built.version,
    packageVersion: versionFile?.packageVersion?.trim() || packageVersion,
    commit,
    gitDescribe: describe,
    syncedAt,
    source: built.source,
  };
}

/** Write a small stamp file (used by WSL sync so Windows builds without .git still show a commit). */
export function formatVersionStamp(info: {
  packageVersion: string;
  commit: string | null;
  describe: string | null;
  syncedAt?: string | null;
}): string {
  return `${JSON.stringify(
    {
      packageVersion: info.packageVersion,
      commit: info.commit,
      describe: info.describe,
      syncedAt: info.syncedAt ?? new Date().toISOString(),
    },
    null,
    2,
  )}\n`;
}
