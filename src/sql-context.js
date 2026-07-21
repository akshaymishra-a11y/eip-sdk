// Error Intelligence Phase 2 (Tier 2.2) — best-effort structured context
// extraction from a raw SQL query string. Deliberately NOT a real SQL
// parser (would be a large dependency for a narrow slice) — just enough
// regex to answer "which table, which operation" for the Database
// dashboard's filtering, matching the same "best-effort, not exhaustive"
// idiom as stacktrace.js's stack-frame parsing. Either field can come back
// null for a query shape this doesn't confidently recognize (a stored
// procedure call, a CTE-only statement, etc) — that's expected, not a bug.
const OPERATION_RE = /^\s*(select|insert|update|delete|create|alter|drop)\b/i;

// Covers the common shapes: "FROM table", "INTO table", "UPDATE table"
// (DELETE FROM is already covered by "FROM"), optionally schema-qualified
// ("public.table") and optionally quoted ("\"table\"" or "`table`").
const TABLE_RE = /\b(?:from|into|update)\s+["`]?([a-zA-Z_][\w.]*)["`]?/i;

function parseSqlContext(queryText) {
  if (!queryText || typeof queryText !== 'string') return { operation: null, table_name: null };
  const opMatch = OPERATION_RE.exec(queryText);
  const tableMatch = TABLE_RE.exec(queryText);
  return {
    operation: opMatch ? opMatch[1].toUpperCase() : null,
    table_name: tableMatch ? tableMatch[1].replace(/^public\./i, '') : null,
  };
}

module.exports = { parseSqlContext };
