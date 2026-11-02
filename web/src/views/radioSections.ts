/**
 * Collapse state for the /radio page's section headings.
 *
 * The page is a stack of sections (收藏电台 / 我的电台 / 正在播放 / 热门电台) and
 * each heading doubles as a toggle. Two rules shape the state:
 *
 *  • A section with nothing to show is collapsed by default. The heading stays,
 *    so the feature is still discoverable and the layout does not jump when the
 *    first item arrives, but it costs one line instead of a title plus an empty
 *    grid.
 *  • An explicit click beats that default and is persisted, so "empty ⇒
 *    collapsed" only holds until the user opens the section themselves.
 *
 * Kept out of the component so both rules can be tested without mounting the
 * page (same reason as radioFilter.ts).
 */

/** Explicit key → collapsed choices. A missing key means "use the default". */
export type CollapsePrefs = Map<string, boolean>;

/**
 * Read the persisted preferences.
 *
 * Older builds stored the *set of collapsed keys* as a JSON array; that is
 * still accepted (every entry becomes `true`) so a returning user keeps their
 * layout instead of everything springing open. Anything unparseable is ignored
 * — localStorage can be disabled, full, or edited by hand.
 */
export function decodeCollapsePrefs(raw: string | null | undefined): CollapsePrefs {
  if (!raw) return new Map();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return new Map(
        parsed.filter((k): k is string => typeof k === 'string').map((k) => [k, true]),
      );
    }
    if (parsed && typeof parsed === 'object') {
      const prefs: CollapsePrefs = new Map();
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'boolean') prefs.set(key, value);
      }
      return prefs;
    }
  } catch {
    /* corrupt value: start from the defaults */
  }
  return new Map();
}

export function encodeCollapsePrefs(prefs: CollapsePrefs): string {
  return JSON.stringify(Object.fromEntries(prefs));
}

/**
 * Whether `key` renders collapsed.
 *
 * `empty` is the section's own "nothing to show" state; it decides the answer
 * only while the user has not clicked the heading.
 */
export function isCollapsed(prefs: CollapsePrefs, key: string, empty = false): boolean {
  return prefs.get(key) ?? empty;
}

/** Flip one section, returning a new map (so a Vue ref re-evaluates). */
export function toggleCollapse(prefs: CollapsePrefs, key: string, empty = false): CollapsePrefs {
  const next = new Map(prefs);
  next.set(key, !isCollapsed(prefs, key, empty));
  return next;
}
