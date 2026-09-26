// @ts-check
import { fetchJsonWithRetry, sleep } from './_http.mjs';
import { decodeEntities } from './_html-entities.mjs';

/** @typedef {import('./_types.js').Provider} Provider */

// Jobicy provider — remote-jobs board (https://jobicy.com), read through its
// public v2 API. Target list: `job_boards:`. Two modes, chosen by whether the
// portals.yml entry carries a `jobicy:` block.
//
// 1. Newest-jobs feed (no `jobicy:` block, the original behaviour): one request
//    to https://jobicy.com/api/v2/remote-jobs?count=50 — the 50 newest postings
//    board-wide, about 6.5 hours of postings (12:25-18:46 UTC on 2026-09-24).
//
// 2. Filtered (`jobicy:` block present): the same endpoint with the API's own
//    server-side filters, one request per tag, deduplicated by posting URL
//    across tags:
//
//      - name: Jobicy
//        provider: jobicy
//        jobicy:
//          tags: ["engineering manager", "software development manager"]
//          geo: canada          # optional; a geoSlug from ?get=locations
//          industry: engineering  # optional; ONE industrySlug from ?get=industries
//
//    At least one of tags / geo / industry is required; with no tags, one
//    request reads the geo/industry filter alone. scan.mjs's title_filter /
//    location_filter still run on everything returned.
//
// Measured against the live API on 2026-09-25 (02:24-02:27 UTC):
//   - count: documented as 1-200. count=500 comes back as 200 (appliedFilters
//     echoes count: 200) and count=0 as 1. Filtered mode always asks for 200.
//   - No pagination. page / offset / paged / start are each rejected with
//     400 "Unexpected parameter", so one request per tag is all a tag can
//     return. A tag that fills all 200 rows is warned about as possibly
//     truncated; tagged results are relevance-ranked, so the cut-off is the
//     least relevant tail (seen: AWS DevOps roles under "engineering team lead").
//   - geo=canada returns Canada-eligible roles plus "Anywhere" (worldwide) ones:
//     102 of 200 rows had jobGeo "Anywhere", every other row listed Canada.
//     geo is case-insensitive (geo=Canada echoes "canada"); an unknown slug is
//     400 "Invalid 'geo' value".
//   - tag is a keyword search over the whole posting (title + description),
//     3-50 characters (else 400). Every word must appear, in any order:
//     tag=engineering manager&geo=canada -> 117 rows, fewer than tag=manager
//     (187). A double-quoted tag is an exact phrase: "engineering manager"
//     -> 29 rows. Tagged results reached back ~30 days (oldest 2026-08-26);
//     untagged results are newest-first, and geo=canada alone at count=200
//     covered only 2026-09-15 onward.
//   - industry takes a single slug; a comma-separated list is 400 "Invalid
//     'industry' value".
//   - No match is a normal envelope: { jobs: [], jobCount: 0, success: true,
//     message: "No jobs found for the applied filters." }.
// Docs: https://github.com/Jobicy/remote-jobs-api (README); jobi.cy/apidocs sits
// behind a Cloudflare challenge. The API asks integrations not to poll more
// often than once an hour; one scan is one request per tag.
//
// Wire in via a `job_boards:` entry with `provider: jobicy`.

const FEED_URL = 'https://jobicy.com/api/v2/remote-jobs?count=50';
const API_URL = 'https://jobicy.com/api/v2/remote-jobs';
const TRUSTED_HOST = 'jobicy.com';
/** Rows per filtered request: the API's per-request cap (measured 2026-09-25). */
const SEARCH_COUNT = 200;
/** The API's accepted tag length (400 outside it). */
const TAG_MIN_LENGTH = 3;
const TAG_MAX_LENGTH = 50;
/** Pause before every filtered request after the first. */
const INTER_REQUEST_DELAY_MS = 250;

/** @param {string} url */
function assertJobicyUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`jobicy: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`jobicy: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== TRUSTED_HOST) {
    throw new Error(`jobicy: untrusted hostname "${parsed.hostname}" — must be ${TRUSTED_HOST}`);
  }
  return url;
}

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Read the entry's optional `jobicy:` filter block. Exported for unit tests.
 *
 * `null` means no block: the entry reads the newest-jobs feed as before. A
 * block that is not a mapping, that sets none of tags / geo / industry, or
 * that carries a tag the API would reject for its length throws — the user
 * asked for a filter and would otherwise silently get the 50-row feed, or a
 * 400 on every scan.
 *
 * @param {any} entry - The job_boards entry.
 * @returns {null | { tags: string[], geo: string, industry: string }}
 *   `tags` holds '' for a geo/industry-only request (no `tag` param).
 */
export function parseJobicyConfig(entry) {
  const cfg = entry?.jobicy;
  if (cfg === undefined || cfg === null) return null;
  const name = entry?.name || '(unnamed)';
  if (typeof cfg !== 'object' || Array.isArray(cfg)) {
    throw new Error(`jobicy: entry "${name}" — jobicy: must be a mapping with tags / geo / industry`);
  }

  const rawTags = typeof cfg.tags === 'string' ? [cfg.tags] : Array.isArray(cfg.tags) ? cfg.tags : [];
  const seen = new Set();
  const tags = [];
  for (const t of rawTags) {
    const trimmed = cleanText(t);
    if (!trimmed || seen.has(trimmed.toLowerCase())) continue;
    if (trimmed.length < TAG_MIN_LENGTH || trimmed.length > TAG_MAX_LENGTH) {
      throw new Error(`jobicy: entry "${name}" tag "${trimmed}" is ${trimmed.length} characters — the API accepts ${TAG_MIN_LENGTH}-${TAG_MAX_LENGTH}`);
    }
    seen.add(trimmed.toLowerCase());
    tags.push(trimmed);
  }
  const geo = cleanText(cfg.geo);
  const industry = cleanText(cfg.industry);
  if (!tags.length && !geo && !industry) {
    throw new Error(`jobicy: entry "${name}" has a jobicy: block with no tags, geo or industry — set at least one, or remove the block to read the newest-jobs feed`);
  }

  return { tags: tags.length ? tags : [''], geo, industry };
}

/**
 * Build one filtered-request URL. Exported for unit tests.
 * @param {string} tag - Keyword search; '' omits `tag`.
 * @param {string} geo - geoSlug; '' omits it.
 * @param {string} industry - industrySlug; '' omits it.
 */
export function buildSearchUrl(tag, geo, industry) {
  const params = new URLSearchParams();
  params.set('count', String(SEARCH_COUNT));
  if (geo) params.set('geo', geo);
  if (industry) params.set('industry', industry);
  if (tag) params.set('tag', tag);
  return `${API_URL}?${params}`;
}

/**
 * Validate one filtered response. A contentless body (null, [], {}, {jobs: null})
 * reads as "no results"; any other envelope without a `jobs` array is an API
 * change and throws, naming the keys it did get.
 * @param {any} json
 * @param {string} label - Tag label for the error message.
 * @returns {any[]}
 */
function readSearchResponse(json, label) {
  if (json === null || json === undefined) return [];
  if (Array.isArray(json)) {
    if (json.length === 0) return [];
  } else if (typeof json === 'object') {
    if (Array.isArray(json.jobs)) return json.jobs;
    if (json.jobs == null && Object.keys(json).every(k => k === 'jobs')) return [];
  }
  const got = json && typeof json === 'object' ? `keys: [${Object.keys(json).join(', ')}]` : typeof json;
  throw new Error(`jobicy: unexpected API response for ${label} — expected { jobs: [...] }, got ${got}`);
}

/**
 * One-line reason for a failed request. A 4xx from this API carries
 * { success: false, error: "..." } naming the bad parameter; surface it.
 * @param {any} err
 */
function describeFailure(err) {
  if (!err?.status) return err?.message || String(err);
  let apiError = '';
  try {
    const body = JSON.parse(err.body);
    if (typeof body?.error === 'string') apiError = body.error.trim().slice(0, 200);
  } catch {
    // Not JSON — the status line is all there is.
  }
  return apiError ? `HTTP ${err.status}: ${apiError}` : `HTTP ${err.status}`;
}

/**
 * Filtered mode: one request per tag, deduplicated by posting URL.
 *
 * Failure policy (recall-first, per tag): a request that still fails after
 * retry skips that tag with a warning. Only when no tag's request came back
 * does fetch() throw, so a dead endpoint or a geo/industry slug the API
 * rejects surfaces as an error rather than an empty board.
 *
 * Health probe (ctx.maxPages set): the first tag only, one request, and a
 * failed request propagates unwrapped so verify-portals can still recognise
 * its own ProbePageBudgetReached.
 *
 * @param {any} entry
 * @param {any} ctx
 * @param {{ tags: string[], geo: string, industry: string }} cfg
 */
async function fetchSearch(entry, ctx, cfg) {
  const probe = Number.isInteger(ctx?.maxPages) && ctx.maxPages > 0;
  const tags = probe ? cfg.tags.slice(0, 1) : cfg.tags;
  const name = entry?.name || 'Jobicy';

  /** @type {Map<string, {title: string, url: string, company: string, location: string, postedAt?: number}>} */
  const byUrl = new Map();
  const failures = [];
  let answered = 0;

  for (let i = 0; i < tags.length; i++) {
    const tag = tags[i];
    const label = tag ? `tag "${tag}"` : '(no tag)';
    if (i > 0) await sleep(INTER_REQUEST_DELAY_MS, ctx);
    const url = assertJobicyUrl(buildSearchUrl(tag, cfg.geo, cfg.industry));

    let json;
    try {
      // redirect:'error' + the fixed host above keep every request on jobicy.com.
      json = await fetchJsonWithRetry(ctx, url, { redirect: 'error' });
    } catch (err) {
      if (probe) throw err;
      failures.push(`${label}: ${describeFailure(err)}`);
      continue;
    }

    const rows = readSearchResponse(json, label);
    answered++;
    for (const job of parseJobicyResponse({ jobs: rows }, name)) {
      if (!byUrl.has(job.url)) byUrl.set(job.url, job);
    }
    if (rows.length >= SEARCH_COUNT && !probe) {
      console.error(`⚠️  jobicy: ${name} ${label} filled the API's ${SEARCH_COUNT}-row cap and it has no pagination, so less relevant matches were cut off — quote the tag for an exact phrase, or add industry, to narrow it`);
    }
  }

  if (answered === 0 && failures.length) {
    throw new Error(`jobicy: all ${tags.length} filtered ${tags.length === 1 ? 'request' : 'requests'} failed — ${failures[0]}`);
  }
  for (const f of failures) console.error(`⚠️  jobicy: ${name} ${f} — skipped, other tags kept`);

  return [...byUrl.values()];
}

/** @type {Provider} */
export default {
  id: 'jobicy',

  detect(entry) {
    return entry?.provider === 'jobicy' ? { url: FEED_URL } : null;
  },

  /**
   * Fetches and normalizes postings: the filtered API when the entry has a
   * `jobicy:` block, otherwise the newest-jobs feed.
   * @param {{ name?: string, provider?: string, jobicy?: any }} entry - The job_boards entry being processed.
   * @param {{ fetchJson: (url: string, opts?: { redirect?: 'error'|'follow'|'manual' }) => Promise<any>, maxPages?: number, sleep?: (ms: number) => Promise<void> }} ctx - HTTP context.
   * @returns {Promise<Array<{title: string, url: string, company: string, location: string, postedAt?: number}>>}
   */
  async fetch(entry, ctx) {
    const search = parseJobicyConfig(entry);
    if (search) return fetchSearch(entry, ctx, search);

    // redirect:'error' prevents SSRF via server-side redirects
    const json = await ctx.fetchJson(FEED_URL, { redirect: 'error' });
    if (!json || !Array.isArray(json.jobs)) {
      throw new Error(`jobicy: unexpected API response — expected { jobs: [...] }, got keys: [${json ? Object.keys(json).join(', ') : 'null'}]`);
    }

    return parseJobicyResponse(json, entry.name || 'Jobicy');
  },
};

/**
 * Parse a Jobicy API response. Exported for unit tests.
 *
 * The API is JSON but its text is WordPress-rendered: titles carry a raw "&",
 * while some company names arrive entity-encoded ("hims &#038; hers", seen
 * 2026-09-25), so title and company go through the shared decoder.
 *
 * @param {any} json - Raw response payload.
 * @param {string} defaultCompany - Fallback company name.
 * @returns {Array<{title: string, url: string, company: string, location: string}>}
 */
export function parseJobicyResponse(json, defaultCompany = 'Jobicy') {
  if (!json || !Array.isArray(json.jobs)) return [];

  const toEpochMs = (value) => {
    if (!value) return undefined;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  };

  return json.jobs
    .map(j => {
      if (!j || typeof j !== 'object') return null;

      const title = typeof j.jobTitle === 'string' ? decodeEntities(j.jobTitle).trim() : '';
      if (!title) return null;

      const rawUrl = typeof j.url === 'string' ? j.url.trim() : '';
      let url = null;
      try {
        const parsed = new URL(rawUrl);
        if (parsed.protocol === 'https:' && (parsed.hostname === 'jobicy.com' || parsed.hostname === 'www.jobicy.com')) {
          url = parsed.href;
        }
      } catch {
        // Invalid or malformed URL
      }
      if (!url) return null;

      const rawCompany = typeof j.companyName === 'string' ? decodeEntities(j.companyName).trim() : '';
      const company = rawCompany || defaultCompany;
      const location = typeof j.jobGeo === 'string' ? j.jobGeo.trim() : '';
      const postedAt = toEpochMs(j.pubDate);

      return {
        title,
        url,
        company,
        location,
        postedAt,
      };
    })
    .filter(j => j !== null);
}
