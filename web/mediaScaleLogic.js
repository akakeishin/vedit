// Pure media-pool scaling helpers. Keep filtering/paging/focus decisions out
// of the DOM layer so the 93+ source behavior can be verified without a
// browser and reused by both rendering and keyboard navigation.

export const MEDIA_PAGE_SIZE = 40;

function normalizeSearchText(value) {
  // Normalization is used for comparison only. The source path/name rendered
  // in the UI is never rewritten, so Japanese and decomposed filesystem names
  // keep their original spelling.
  return String(value ?? '').normalize('NFKC').toLowerCase();
}

export function mediaSearchTerms(query) {
  return normalizeSearchText(query).trim().split(/\s+/u).filter(Boolean);
}

/** Match every whitespace-delimited term against the source's full path. */
export function filterMediaSources(sources, query) {
  const terms = mediaSearchTerms(query);
  if (terms.length === 0) return [...sources];
  return sources.filter((source) => {
    const haystack = normalizeSearchText(source?.path);
    return terms.every((term) => haystack.includes(term));
  });
}

/** Return the filtered set plus only the current render chunk. */
export function mediaPage(sources, query, visibleLimit = MEDIA_PAGE_SIZE) {
  const matched = filterMediaSources(sources, query);
  const limit = Number.isFinite(visibleLimit)
    ? Math.max(1, Math.floor(visibleLimit))
    : MEDIA_PAGE_SIZE;
  const visible = matched.slice(0, limit);
  return {
    matched,
    visible,
    hiddenCount: Math.max(0, matched.length - visible.length),
  };
}

/** Keep the roving focus on a rendered source, repairing stale/filtered ids. */
export function repairMediaFocus(visibleSourceIds, currentId) {
  if (visibleSourceIds.length === 0) return null;
  return visibleSourceIds.includes(currentId) ? currentId : visibleSourceIds[0];
}

/** Arrow/Home/End navigation is intentionally bounded to rendered cards. */
export function mediaFocusTarget(visibleSourceIds, currentId, key) {
  if (visibleSourceIds.length === 0) return null;
  const repaired = repairMediaFocus(visibleSourceIds, currentId);
  const index = visibleSourceIds.indexOf(repaired);
  if (key === 'Home') return visibleSourceIds[0];
  if (key === 'End') return visibleSourceIds[visibleSourceIds.length - 1];
  if (key === 'ArrowUp') return visibleSourceIds[Math.max(0, index - 1)];
  if (key === 'ArrowDown') return visibleSourceIds[Math.min(visibleSourceIds.length - 1, index + 1)];
  return repaired;
}
