// Memory Core plugin module implements ranked search stream merging.

type ScoredResult = { score: number };

/**
 * Merge two already-ranked streams by comparing only their heads.
 * Each backend owns its ranking, so a stream is never reordered.
 */
export function mergeRankedStreamsByScore<T extends ScoredResult>(
  primary: readonly T[],
  secondary: readonly T[],
): T[] {
  const merged: T[] = [];
  let primaryIndex = 0;
  let secondaryIndex = 0;
  while (primaryIndex < primary.length && secondaryIndex < secondary.length) {
    const head = primary[primaryIndex];
    const candidate = secondary[secondaryIndex];
    if ((head?.score ?? 0) >= (candidate?.score ?? 0)) {
      if (head) {
        merged.push(head);
      }
      primaryIndex += 1;
    } else {
      if (candidate) {
        merged.push(candidate);
      }
      secondaryIndex += 1;
    }
  }
  merged.push(...primary.slice(primaryIndex), ...secondary.slice(secondaryIndex));
  return merged;
}
