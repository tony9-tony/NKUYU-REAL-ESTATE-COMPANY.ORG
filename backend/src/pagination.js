// ---------------------------------------------------------------------------
// MKUYU opt-in list pagination.
//
// Shared by ./routes/api.js and ./routes/org.js so both routers validate page
// arguments identically and produce the same `pagination` block. There is one
// implementation of the contract, so a new list route cannot accidentally
// invent a slightly different one.
//
// THE CONTRACT IS OFF BY DEFAULT. Every list endpoint answers with a bare JSON
// array unless the caller supplies `page` or `page_size`. The SPA, roughly a
// dozen scripts and the existing suites all depend on that shape, and the
// frontend renders whole arrays (client-side search, `.find()` in modals, alert
// counts), so switching a default would be a breaking change rather than an
// optimisation.
//
// With `page`/`page_size` the response becomes `{ data, pagination }` and
// LIMIT/OFFSET are applied INSIDE SQL, after the caller's record scope has
// already been applied by `scopeCondition`. Rows are never fetched-then-sliced,
// and `total` is counted with the same predicate, so neither a page nor a count
// can expose a record the caller may not see.
// ---------------------------------------------------------------------------
import { query } from "./db.js";

/** Mirrors the router-local `HttpError`, which is not exported from the routers. */
class PaginationError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "PaginationError";
    this.status = status;
  }
}

const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 50;
// A page far beyond any real dataset would make Postgres scan an absurd OFFSET
// just to return nothing, so the derived offset is bounded rather than trusted.
const MAX_OFFSET = 10_000_000;

/** True when the caller opted in by supplying any pagination parameter. */
function paginationRequested(queryParams) {
  const q = queryParams || {};
  // `search` counts as opting in. A searched response is inherently scoped to
  // the term, and must report its total - but more importantly, a bare
  // `?search=` must never return an UNBOUNDED matching array, which is exactly
  // what the unpaginated shape would hand back on a 12,000-row table.
  return q.page !== undefined || q.page_size !== undefined || q.search !== undefined;
}

function positiveInt(value, field) {
  // String coercion is deliberate: query params always arrive as strings, and
  // `Number("")` is 0, which is exactly the absurd value to reject.
  if (value === undefined || value === null || String(value).trim() === "") {
    throw new PaginationError(400, `${field} is required`);
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new PaginationError(400, `${field} must be a positive integer`);
  return n;
}

function parsePagination(queryParams) {
  const q = queryParams || {};
  const page = positiveInt(q.page ?? 1, "page");
  const pageSize = positiveInt(q.page_size ?? DEFAULT_PAGE_SIZE, "page_size");
  if (pageSize > MAX_PAGE_SIZE) throw new PaginationError(400, `page_size must be ${MAX_PAGE_SIZE} or fewer`);
  const offset = (page - 1) * pageSize;
  if (!Number.isSafeInteger(offset)) throw new PaginationError(400, "page is out of range");
  if (offset > MAX_OFFSET) throw new PaginationError(400, "page is out of range");
  return { page, pageSize, offset, limit: pageSize };
}

/** The `pagination` block, derived from the rows actually returned. */
function paginationMeta({ page, pageSize, total }) {
  const totalPages = total > 0 ? Math.ceil(total / pageSize) : 0;
  return {
    page,
    page_size: pageSize,
    total,
    total_pages: totalPages,
    has_next: page < totalPages,
    has_previous: page > 1 && total > 0,
  };
}

/**
 * Runs a scoped, ordered, paginated read.
 *
 * `build()` must return `{ sql, countSql, values }` where BOTH statements are
 * built from one `where` fragment. That is the property that keeps the count
 * honest: a count assembled independently could drift from the data query's
 * filter and disclose how many records the caller is not allowed to see.
 */
async function paginatedList({ build, page, pageSize, offset, limit }) {
  const built = await build();
  const paged = await query(`${built.sql} LIMIT $${built.values.length + 1} OFFSET $${built.values.length + 2}`, [
    ...built.values, limit, offset,
  ]);
  const counted = await query(built.countSql, built.values);
  const total = Number(counted.rows[0]?.total ?? 0);
  // A model may attach a `resolve` hook for per-row enrichment (property picture
  // counts). It runs on the PAGE only, so it never walks the whole table.
  const rows = built.resolve ? await built.resolve(paged.rows) : paged.rows;
  return { rows, pagination: paginationMeta({ page, pageSize, total }) };
}

/**
 * A list search term.
 *
 * Searching happens in SQL, inside the same scoped statement that produces the
 * page, so the browser only ever holds one page and still searches the whole
 * authorized set. The value is length-capped here and is always bound as a
 * parameter downstream - it is never interpolated into SQL.
 */
function searchTerm(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.length > 120) throw new PaginationError(400, "search must be 120 characters or fewer");
  return text;
}

// MK-10: a list requested WITHOUT page/page_size (the legacy bare-array form)
// still never returns more than this many rows. The screens use pages.
export const UNPAGED_LIMIT = 1000;

export { MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE, paginatedList, paginationRequested, parsePagination, paginationMeta, searchTerm };
