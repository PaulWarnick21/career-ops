// @ts-check
import { fetchJsonWithRetry, sleep } from './_http.mjs';

/** @typedef {import('./_types.js').Provider} Provider */

// Himalayas provider - remote-jobs board (https://himalayas.app). Two modes,
// chosen by whether the portals.yml entry carries a `himalayas:` block.
//
// 1. Browse feed (no `himalayas:` block, the original behaviour): one request
//    to the board-wide feed (https://himalayas.app/jobs/api?limit=50). The API
//    caps every response at 20 rows ("reduced the maximum limit to 20 jobs
//    per request", March 2025), so this reads only the 20 newest postings of a
//    ~100k-job board - roughly 45 minutes of postings per scan.
//
// 2. Search (`himalayas:` block present): the documented search endpoint
//    (https://himalayas.app/jobs/api/search), one paginated sweep per query,
//    deduplicated by posting URL across queries:
//
//      - name: Himalayas
//        provider: himalayas
//        himalayas:
//          queries: ["engineering manager", "engineering team lead"]
//          country: CA        # optional; ISO alpha-2 or a country name, or a list
//          max_pages: 10      # optional; pages per query, 20 rows a page
//          delay_ms: 1200     # optional; pause between requests (default 250, never lower)
//
//    `country` makes the API return only postings a resident of that country
//    is eligible for: roles whose locationRestrictions include it, plus
//    unrestricted (worldwide) ones. Either `queries` or `country` is required;
//    a country with no queries sweeps every eligible posting. A list
//    (`country: [GB, DE]`) sweeps every query once per country, one country
//    after another; the API takes one country per request.
//
//    Measured 2026-09-24: q=engineering manager&country=CA -> totalCount 354,
//    against the 20 rows the browse feed returns. The search pages with a
//    1-based `?page=N` (20 rows a page; it returns no `nextCursor` - that is
//    the browse feed's pagination). Results are relevance-ranked and the tail
//    drifts: for that query, pages 1-6 were mostly EM titles and pages 7-18
//    mostly unrelated roles, which is what DEFAULT_MAX_PAGES is sized to.
//    scan.mjs's title_filter / location_filter still run on everything
//    returned.
//
// Wire in via a `job_boards:` entry with `provider: himalayas`.

const FEED_URL = 'https://himalayas.app/jobs/api?limit=50';
const SEARCH_URL = 'https://himalayas.app/jobs/api/search';
const TRUSTED_HOST = 'himalayas.app';
/** Rows per search page: the API's per-request cap (measured 2026-09-24). */
const SEARCH_PAGE_SIZE = 20;
/** Pages per query when neither `himalayas.max_pages` nor `max_pages` is set. */
const DEFAULT_MAX_PAGES = 10;
/** Hard ceiling on a configured max_pages (1,000 rows per query). */
const MAX_PAGES_CAP = 50;
/** Pause before every search request after the first; the API answers 429 past an unpublished rate. */
const INTER_PAGE_DELAY_MS = 250;
/**
 * Ceiling on a configured `himalayas.delay_ms`. A long sweep needs a slower
 * pace than the default: ~150 requests at 250ms got HTTP 429 from about the
 * 100th on (2026-10-31), while ~240 at 1200ms went through clean.
 */
const MAX_DELAY_MS = 10_000;

/** @param {string} url */
function assertHimalayasUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`himalayas: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`himalayas: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== TRUSTED_HOST) {
    throw new Error(`himalayas: untrusted hostname "${parsed.hostname}" - must be ${TRUSTED_HOST}`);
  }
  return url;
}

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function cleanHimalayasUrl(value) {
  const raw = cleanText(value);
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase();
    const trusted = host === TRUSTED_HOST || host.endsWith(`.${TRUSTED_HOST}`);
    return parsed.protocol === 'https:' && trusted ? parsed.href : '';
  } catch {
    return '';
  }
}

function locationText(value) {
  if (!Array.isArray(value)) return '';
  return value
    .filter(v => typeof v === 'string' && v.trim())
    .map(v => v.trim())
    .join(', ');
}

// Himalayas pubDate is currently epoch seconds. Accept milliseconds and
// parseable date strings too so the parser survives small API shape changes.
function toEpochMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

/** @param {unknown} value */
function nonNegativeInt(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Read the entry's optional `himalayas:` search block. Exported for unit tests.
 *
 * `null` means no block: the entry reads the browse feed as before. A block
 * that is not a mapping, or that sets neither `queries` nor `country`, throws -
 * the user asked for a search and would otherwise silently get the 20-row feed.
 * Page budget: `himalayas.max_pages`, else the entry-level `max_pages` other
 * providers use, else DEFAULT_MAX_PAGES; always capped at MAX_PAGES_CAP.
 *
 * `country` is one country or a list of them; each is swept in turn.
 * `delay_ms` slows the pause between requests (never below the 250ms default,
 * capped at MAX_DELAY_MS).
 *
 * @param {any} entry - The job_boards entry.
 * @returns {null | { queries: string[], countries: string[], maxPages: number, delayMs: number }}
 *   `queries` holds '' for a country-only sweep (no `q` param); `countries`
 *   holds '' when no country filter is set.
 */
export function parseHimalayasConfig(entry) {
  const cfg = entry?.himalayas;
  if (cfg === undefined || cfg === null) return null;
  const name = entry?.name || '(unnamed)';
  if (typeof cfg !== 'object' || Array.isArray(cfg)) {
    throw new Error(`himalayas: entry "${name}" - himalayas: must be a mapping with queries / country / max_pages`);
  }

  const queries = cleanList(cfg.queries);
  const countries = cleanList(cfg.country);
  if (!queries.length && !countries.length) {
    throw new Error(`himalayas: entry "${name}" has a himalayas: block with no queries and no country - set at least one, or remove the block to read the newest-jobs feed`);
  }

  let maxPages = DEFAULT_MAX_PAGES;
  for (const v of [cfg.max_pages, entry?.max_pages]) {
    if (Number.isInteger(v) && v > 0) {
      maxPages = Math.min(v, MAX_PAGES_CAP);
      break;
    }
  }

  // Never faster than the default pace: delay_ms only slows a long sweep down.
  const delayMs = Number.isInteger(cfg.delay_ms) && cfg.delay_ms > INTER_PAGE_DELAY_MS
    ? Math.min(cfg.delay_ms, MAX_DELAY_MS)
    : INTER_PAGE_DELAY_MS;

  return { queries: queries.length ? queries : [''], countries: countries.length ? countries : [''], maxPages, delayMs };
}

/**
 * A string or a list of strings, trimmed, blanks and non-strings dropped,
 * deduplicated case-insensitively (first spelling kept).
 * @param {unknown} value
 * @returns {string[]}
 */
function cleanList(value) {
  const raw = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
  const seen = new Set();
  const out = [];
  for (const v of raw) {
    const trimmed = cleanText(v);
    if (!trimmed || seen.has(trimmed.toLowerCase())) continue;
    seen.add(trimmed.toLowerCase());
    out.push(trimmed);
  }
  return out;
}

/**
 * Build one search-endpoint URL. Exported for unit tests.
 * @param {string} query - Free-text query; '' omits `q`.
 * @param {string} country - Country filter; '' omits it.
 * @param {number} page - 1-based page.
 */
export function buildSearchUrl(query, country, page) {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  if (country) params.set('country', country);
  params.set('page', String(page));
  return `${SEARCH_URL}?${params}`;
}

/**
 * Validate one search response. A contentless body (null, [], {}, {jobs: null})
 * reads as "no results"; any other envelope without a `jobs` array is an API
 * change and throws, naming the keys it did get.
 * @param {any} json
 * @param {string} label - Query label for the error message.
 * @returns {{ rows: any[], total?: number, offset?: number }}
 */
function readSearchPage(json, label) {
  if (json === null || json === undefined) return { rows: [] };
  if (Array.isArray(json)) {
    if (json.length === 0) return { rows: [] };
  } else if (typeof json === 'object') {
    if (Array.isArray(json.jobs)) {
      return { rows: json.jobs, total: nonNegativeInt(json.totalCount), offset: nonNegativeInt(json.offset) };
    }
    if (json.jobs == null && Object.keys(json).every(k => k === 'jobs')) return { rows: [] };
  }
  const got = json && typeof json === 'object' ? `keys: [${Object.keys(json).join(', ')}]` : typeof json;
  throw new Error(`himalayas: unexpected search response for ${label} - expected { jobs: [...] }, got ${got}`);
}

/**
 * Search mode: one paginated sweep per query (per country, when several are
 * set), deduplicated by posting URL. Countries run one after another on the
 * same pacing, never in parallel: separate entries per country run in
 * parallel and tripped the API's rate limit (HTTP 429, 2026-10-31).
 *
 * Termination per query: an empty page always ends it; otherwise the
 * response's own totalCount (offset + rows reached it); a short page only when
 * totalCount is absent or non-positive. The page count is never taken from
 * totalCount alone - `maxPages` bounds every query.
 *
 * Failure policy (recall-first, per query): a request that still fails after
 * retry ends that query only, keeping the pages it already returned, with a
 * warning. Only when no query's first page came back does fetch() throw, so a
 * dead endpoint surfaces as an error rather than an empty board.
 *
 * Health probe (ctx.maxPages set): the first query of the first country only,
 * at most ctx.maxPages pages, and a failed request propagates unwrapped so
 * verify-portals can still recognise its own ProbePageBudgetReached.
 *
 * @param {any} entry
 * @param {any} ctx
 * @param {{ queries: string[], countries: string[], maxPages: number, delayMs: number }} cfg
 */
async function fetchSearch(entry, ctx, cfg) {
  const probeCap = Number.isInteger(ctx?.maxPages) && ctx.maxPages > 0 ? ctx.maxPages : 0;
  const queries = probeCap ? cfg.queries.slice(0, 1) : cfg.queries;
  const countries = probeCap ? cfg.countries.slice(0, 1) : cfg.countries;
  const pagesPerQuery = probeCap ? Math.min(cfg.maxPages, probeCap) : cfg.maxPages;
  const name = entry?.name || 'Himalayas';
  const searches = [];
  for (const country of countries) {
    for (const query of queries) searches.push({ query, country });
  }

  /** @type {Map<string, {title: string, url: string, company: string, location: string, postedAt?: number}>} */
  const byUrl = new Map();
  const failures = [];
  let answered = 0;
  let requests = 0;

  for (const { query, country } of searches) {
    const label = (query ? `"${query}"` : '(country only)') + (countries.length > 1 ? ` [${country}]` : '');
    for (let page = 1; page <= pagesPerQuery; page++) {
      if (requests++ > 0) await sleep(cfg.delayMs, ctx);
      const url = assertHimalayasUrl(buildSearchUrl(query, country, page));

      let json;
      try {
        // redirect:'error' + the fixed host above keep every request on himalayas.app.
        json = await fetchJsonWithRetry(ctx, url, { redirect: 'error' });
      } catch (err) {
        if (probeCap) throw err;
        const reason = err?.status ? `HTTP ${err.status}` : (err?.message || String(err));
        if (page === 1) failures.push(`${label}: ${reason}`);
        else console.error(`⚠️  himalayas: ${name} ${label} failed on page ${page} (${reason}) - keeping pages 1-${page - 1}`);
        break;
      }

      const { rows, total, offset } = readSearchPage(json, label);
      if (page === 1) answered++;
      for (const job of parseHimalayasResponse({ jobs: rows })) {
        if (!byUrl.has(job.url)) byUrl.set(job.url, job);
      }

      if (rows.length === 0) break;
      if (total !== undefined && total > 0) {
        const reached = (offset ?? (page - 1) * SEARCH_PAGE_SIZE) + rows.length;
        if (reached >= total) break;
        if (page === pagesPerQuery && !probeCap) {
          console.error(`⚠️  himalayas: ${name} ${label} truncated at max_pages=${pagesPerQuery} (${reached} of ${total} results) - raise himalayas.max_pages on this entry for more`);
        }
      } else if (rows.length < SEARCH_PAGE_SIZE) {
        break;
      }
    }
  }

  if (answered === 0 && failures.length) {
    throw new Error(`himalayas: all ${searches.length} search ${searches.length === 1 ? 'query' : 'queries'} failed - ${failures[0]}`);
  }
  for (const f of failures) console.error(`⚠️  himalayas: ${name} query ${f} - skipped, other queries kept`);

  return [...byUrl.values()];
}

/** @type {Provider} */
export default {
  id: 'himalayas',

  detect(entry) {
    return entry?.provider === 'himalayas' ? { url: FEED_URL } : null;
  },

  /**
   * Fetches and normalizes postings: the search endpoint when the entry has a
   * `himalayas:` block, otherwise the newest-jobs browse feed.
   * @param {{ name?: string, provider?: string, himalayas?: any, max_pages?: number }} entry - The job_boards entry being processed.
   * @param {{ fetchJson: (url: string, opts?: { redirect?: 'error'|'follow'|'manual' }) => Promise<any>, maxPages?: number, sleep?: (ms: number) => Promise<void> }} ctx - HTTP context.
   * @returns {Promise<Array<{title: string, url: string, company: string, location: string, postedAt?: number}>>}
   */
  async fetch(entry, ctx) {
    const search = parseHimalayasConfig(entry);
    if (search) return fetchSearch(entry, ctx, search);

    const feedUrl = assertHimalayasUrl(FEED_URL);
    // redirect:'error' prevents SSRF via server-side redirects; combined with
    // assertHimalayasUrl above it keeps the request pinned to himalayas.app.
    const json = await ctx.fetchJson(feedUrl, { redirect: 'error' });
    if (!json || !Array.isArray(json.jobs)) {
      throw new Error(`himalayas: unexpected API response - expected { jobs: [...] }, got keys: [${json ? Object.keys(json).join(', ') : 'null'}]`);
    }
    return parseHimalayasResponse(json);
  },
};

/**
 * Parse Himalayas' public jobs API response. Exported for unit tests.
 *
 * Shape: `{ jobs: [...] }`, where each job currently carries `title`,
 * `companyName`, `locationRestrictions`, `applicationLink`, `guid`,
 * `pubDate`, and `companySlug`. `applicationLink` is preferred over `guid`
 * and used as the dedup key after HTTPS + host validation.
 *
 * @param {unknown} json - raw parsed API response
 * @returns {Array<{title: string, url: string, company: string, location: string, postedAt?: number}>}
 */
export function parseHimalayasResponse(json) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.jobs)) return [];

  const jobs = [];
  for (const item of json.jobs) {
    if (!item || typeof item !== 'object') continue;

    const title = cleanText(item.title);
    if (!title) continue;

    const url = cleanHimalayasUrl(item.applicationLink) || cleanHimalayasUrl(item.guid);
    if (!url) continue;

    jobs.push({
      title,
      url,
      company: cleanText(item.companyName),
      location: locationText(item.locationRestrictions),
      postedAt: toEpochMs(item.pubDate),
    });
  }

  return jobs;
}
