/**
 * Primitives shared between the synchronous db-query path (db-query.ts) and
 * the bounded child-process path (db-query-bounded.ts). Split out to avoid a
 * circular import: db-query.ts's HTTP handler calls into the bounded
 * executor, and the bounded executor reuses the same single-statement guard.
 */

export interface DbQueryResult {
  columns: string[];
  rows: unknown[][];
  elapsed: number;
  total: number;
}

export function stripTrailingSemicolon(sql: string): string {
  return sql.trim().replace(/;\s*$/, "").trim();
}

export function assertSingleStatement(sql: string): void {
  const stripped = stripTrailingSemicolon(sql);
  if (stripped.includes(";")) {
    throw new Error("Only one SQL statement is allowed");
  }
}
