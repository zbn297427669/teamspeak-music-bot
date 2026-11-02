/**
 * Filtering for operator-imported radio stations on the /radio page.
 *
 * The page has one "分组 / 风格" dropdown that serves two different station
 * vocabularies at once:
 *
 *  • the Radio Browser directory, whose tags ("jazz", "classical") are queried
 *    server-side, and
 *  • locally imported stations, which carry only a playlist `group-title`
 *    ("古典·轻音·治愈") plus whatever the name and note say.
 *
 * The directory cannot answer for an import and an import group is not a
 * directory tag, so each side filters itself from the same selection. Keeping
 * that decision here — rather than inline in the component — makes the
 * behaviour testable without mounting the page.
 */

/** The minimum shape these helpers need; structurally satisfied by the page's
 *  `Song & { group, local }` rows. */
export interface LocalStationLike {
  name: string;
  /** Playlist group-title. Missing means DEFAULT_GROUP. */
  group?: string;
  /** Note column; the page stores `group,note` here. */
  album?: string;
}

/** Group used when an import carried no `group-title`, mirroring
 *  `DEFAULT_GROUP` in `src/music/radio-local.ts`. Duplicated rather than
 *  imported so the browser bundle does not pull in the Node-only store. */
export const DEFAULT_LOCAL_GROUP = "本地导入";

export interface RadioFilterSelection {
  /** Selected value of the combined group/tag dropdown. */
  tag: string;
  /** Directory-only facet: imports have no country. */
  country: string;
  /** Directory-only facet: imports report no bitrate. */
  bitrateMin: number;
}

export interface GroupCount {
  name: string;
  count: number;
}

const groupOf = (s: LocalStationLike): string => s.group || DEFAULT_LOCAL_GROUP;

/**
 * True when `tag` names one of the operator's own groups.
 *
 * Such a value cannot exist in the directory, so the caller uses it to skip
 * the directory request entirely instead of painting an empty result list.
 */
export function isLocalGroupTag(tag: string, groups: GroupCount[]): boolean {
  const t = tag.trim();
  return t !== "" && groups.some((g) => g.name === t);
}

/**
 * Imported stations matching the current selection.
 *
 *  • no filter             → every import
 *  • tag is a local group  → that group only
 *  • tag is anything else  → substring match over name / group / note, which is
 *    what a user means when they pick "jazz" and own "Jazz Radio"
 *  • country or bitrate    → nothing: those facets describe directory records
 *    and an import carries neither, so showing them anyway would claim a match
 *    that the chosen filter never checked
 */
export function filterLocalStations<T extends LocalStationLike>(
  stations: T[],
  selection: RadioFilterSelection,
  groups: GroupCount[],
): T[] {
  if (selection.country.trim() || selection.bitrateMin > 0) return [];

  const tag = selection.tag.trim();
  if (!tag) return stations;

  if (isLocalGroupTag(tag, groups)) {
    return stations.filter((s) => groupOf(s) === tag);
  }

  const needle = tag.toLowerCase();
  return stations.filter((s) =>
    [s.name, s.group, s.album].some((field) => (field ?? "").toLowerCase().includes(needle)),
  );
}

/**
 * Group headers for the filtered list, re-counted so a header never claims
 * more stations than are rendered beneath it.
 *
 * Order follows `groups` (the store's first-seen order) so filtering never
 * reshuffles the section.
 */
export function groupCounts<T extends LocalStationLike>(
  stations: T[],
  groups: GroupCount[],
): GroupCount[] {
  const counts = new Map<string, number>();
  for (const s of stations) {
    const g = groupOf(s);
    counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  return groups
    .filter((g) => counts.has(g.name))
    .map((g) => ({ name: g.name, count: counts.get(g.name) as number }));
}
