import { ref, computed, onMounted } from "vue";
import { apiFetch } from "../api/http.js";

export type AppVersionInfo = {
  version: string;
  packageVersion?: string;
  commit?: string | null;
  gitDescribe?: string | null;
  syncedAt?: string | null;
  source?: string;
};

const versionInfo = ref<AppVersionInfo | null>(null);
const versionError = ref<string | null>(null);
let loading: Promise<void> | null = null;

async function loadVersion(force = false): Promise<void> {
  if (versionInfo.value && !force) return;
  if (loading && !force) return loading;
  loading = (async () => {
    try {
      const res = await apiFetch("/api/health");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as AppVersionInfo & { status?: string };
      versionInfo.value = {
        version: data.version || data.packageVersion || "unknown",
        packageVersion: data.packageVersion,
        commit: data.commit ?? null,
        gitDescribe: data.gitDescribe ?? null,
        syncedAt: data.syncedAt ?? null,
        source: data.source,
      };
      versionError.value = null;
    } catch (e) {
      versionError.value = e instanceof Error ? e.message : String(e);
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/** Shared app version for Navbar / Settings. Call ensure() once on mount. */
export function useAppVersion() {
  onMounted(() => {
    void loadVersion();
  });

  const display = computed(() => versionInfo.value?.version ?? "");
  const detail = computed(() => {
    const v = versionInfo.value;
    if (!v) return "";
    const bits: string[] = [];
    if (v.packageVersion && v.packageVersion !== v.version) {
      bits.push(`package ${v.packageVersion}`);
    }
    if (v.commit) bits.push(v.commit);
    if (v.syncedAt) bits.push(`synced ${v.syncedAt}`);
    if (v.source) bits.push(`via ${v.source}`);
    return bits.join(" · ");
  });

  return {
    versionInfo,
    versionError,
    display,
    detail,
    refresh: () => loadVersion(true),
  };
}
