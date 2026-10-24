/**
 * Helpers shared by the homelab behaviors.
 *
 * @module
 */

// Characters Windows refuses in a directory name. Control characters are on
// that list, which is exactly why this regex contains them.
// deno-lint-ignore no-control-regex
const UNSAFE = /[<>:"/\\|?*\u0000-\u001f]+/g;

/**
 * Turn a name from an API (pool, app, album, stream) into a data instance name
 * that is a valid directory name on every OS, with a prefix so instances of
 * different resource specs never collide on disk.
 */
export function instanceName(prefix: string, name: string): string {
  const safe = name
    .replace(UNSAFE, "-")
    .replace(/[. ]+$/, "")
    .replace(/^-+|-+$/g, "") || "unnamed";
  return `${prefix}-${safe}`;
}

/** Percentage with one decimal, or 0 when the total is unknown. */
export function percent(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 1000) / 10 : 0;
}

/** ISO timestamp for resource data. */
export function now(): string {
  return new Date().toISOString();
}
