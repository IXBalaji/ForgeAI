import { ACTIVITY_TAG_PATTERN, EXCLUDED_ACTIVITY_TAGS } from "./results-constants";

/**
 * Narrows a raw log tail down to the lines worth showing a user watching a
 * run live: tagged pipeline messages only. Drops blank lines, the untagged
 * multi-line OTEL/JSON dumps interleaved in the log, and tags that are pure
 * startup/diagnostic noise (see EXCLUDED_ACTIVITY_TAGS).
 */
export function filterActivityLines(lines: string[], limit: number): string[] {
  const kept: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    const match = line.match(ACTIVITY_TAG_PATTERN);
    if (!match) continue;
    if (EXCLUDED_ACTIVITY_TAGS.includes(match[1])) continue;
    kept.push(line);
  }
  return kept.slice(-limit);
}
