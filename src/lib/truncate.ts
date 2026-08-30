/**
 * Row capping (see docs/DESIGN.md §6).
 *
 * GA4 and Search Console responses will happily return tens of thousands of rows
 * and destroy an agent's context window. Every list/report tool passes through here.
 */

export interface TruncatedResult<T> {
  rows: T[];
  /** Rows actually returned. */
  rowCount: number;
  /** Rows the upstream API reported before capping, when known. */
  totalRows?: number;
  /** Present and true only when rows were dropped. */
  truncated?: true;
  /** Guidance for the agent when output was clipped. */
  note?: string;
}

/**
 * Cap `rows` at `limit`, reporting whether anything was dropped.
 *
 * Callers typically over-fetch by one row so truncation stays detectable even
 * when the upstream API omits a total. In that case `totalRows` is unknown and
 * the note must not imply a precise total — saying "25 of 26" when the real
 * total is 40,000 would actively mislead the calling agent.
 *
 * @param rows      Rows already normalized into flat objects.
 * @param limit     Effective cap, resolved by resolveLimit().
 * @param totalRows Upstream total, if the API reported one.
 */
export function truncateRows<T>(
  rows: T[],
  limit: number,
  totalRows?: number,
): TruncatedResult<T> {
  if (rows.length <= limit) {
    return {
      rows,
      rowCount: rows.length,
      ...(totalRows !== undefined ? { totalRows } : {}),
    };
  }

  const clipped = rows.slice(0, limit);
  const advice =
    "Raise `limit` to see more, or narrow the query with filters or a shorter date range. " +
    "Prefer narrowing over raising — large responses consume context quickly.";

  if (totalRows === undefined) {
    return {
      rows: clipped,
      rowCount: clipped.length,
      truncated: true,
      note:
        `Returned ${clipped.length} rows; more are available but the API did not report a total. ` +
        advice,
    };
  }

  return {
    rows: clipped,
    rowCount: clipped.length,
    totalRows,
    truncated: true,
    note: `Returned ${clipped.length} of ${totalRows} rows. ` + advice,
  };
}

/**
 * Resolve the row cap for a request.
 *
 * An omitted limit yields the configured default (25). A caller may exceed it
 * deliberately, but never past the hard ceiling.
 */
export function resolveLimit(
  requested: number | undefined,
  defaultLimit: number,
  maxLimit: number,
): number {
  if (requested === undefined) return defaultLimit;
  if (!Number.isFinite(requested) || requested < 1) return defaultLimit;
  return Math.min(Math.floor(requested), maxLimit);
}
