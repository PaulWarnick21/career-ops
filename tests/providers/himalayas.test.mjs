// tests/providers/himalayas.test.mjs — moved verbatim from test-all.mjs (#1440);
// search-mode section added below.
import { pass, fail, ROOT } from '../helpers.mjs';
import { readFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — himalayas');

try {
  const himalayasModule = await import(pathToFileURL(join(ROOT, 'providers/himalayas.mjs')).href);
  const himalayas = himalayasModule.default;
  const { parseHimalayasResponse } = himalayasModule;

  if (himalayas.id === 'himalayas') pass('himalayas.id is "himalayas"');
  else fail(`himalayas.id is ${JSON.stringify(himalayas.id)}`);

  const hit = himalayas.detect({ name: 'Himalayas', provider: 'himalayas' });
  if (hit && hit.url === 'https://himalayas.app/jobs/api?limit=50') {
    pass('himalayas.detect() claims explicit provider config');
  } else {
    fail(`himalayas.detect() returned ${JSON.stringify(hit)}`);
  }

  if (himalayas.detect({ name: 'Remote Board', provider: 'remotive' }) === null) {
    pass('himalayas.detect() ignores other provider ids');
  } else {
    fail('himalayas.detect() should only claim provider: himalayas');
  }

  const sample = {
    jobs: [
      {
        title: '  Staff AI Engineer  ',
        companyName: ' Acme Labs ',
        companySlug: 'acme-labs',
        locationRestrictions: ['Worldwide', 'Europe'],
        pubDate: 1782538666,
        applicationLink: 'https://himalayas.app/companies/acme-labs/jobs/staff-ai-engineer',
        guid: 'https://himalayas.app/companies/acme-labs/jobs/staff-ai-engineer-guid',
      },
      {
        title: 'Product Manager',
        companyName: 'Fallback Co',
        companySlug: 'fallback-co',
        locationRestrictions: [],
        pubDate: '2026-01-02T09:00:00Z',
        applicationLink: '',
        guid: 'https://himalayas.app/companies/fallback-co/jobs/product-manager',
      },
      {
        title: 'Missing Link Role',
        companyName: 'Dropped Co',
        locationRestrictions: ['United States'],
      },
      {
        title: 'Off Host Role',
        companyName: 'Bad Co',
        locationRestrictions: ['Remote'],
        applicationLink: 'https://example.com/companies/bad/jobs/off-host',
      },
      {
        title: 'HTTP Role',
        companyName: 'Bad Scheme Co',
        locationRestrictions: ['Remote'],
        applicationLink: 'http://himalayas.app/companies/bad/jobs/http-role',
      },
      {
        title: '   ',
        companyName: 'Blank Title Co',
        locationRestrictions: ['Remote'],
        applicationLink: 'https://himalayas.app/companies/blank/jobs/blank-title',
      },
    ],
  };
  const jobs = parseHimalayasResponse(sample);

  if (jobs.length === 2) pass('parseHimalayasResponse keeps 2 jobs (drops missing/off-host/http/blank-title rows)');
  else fail(`parseHimalayasResponse returned ${jobs.length} jobs (expected 2)`);

  if (jobs[0]?.title === 'Staff AI Engineer' && jobs[0]?.company === 'Acme Labs') {
    pass('parseHimalayasResponse trims title and companyName');
  } else {
    fail(`row 0 title/company = ${JSON.stringify({ title: jobs[0]?.title, company: jobs[0]?.company })}`);
  }

  if (jobs[0]?.location === 'Worldwide, Europe') {
    pass('parseHimalayasResponse joins locationRestrictions');
  } else {
    fail(`row 0 location = ${JSON.stringify(jobs[0]?.location)}`);
  }

  if (jobs[0]?.url === 'https://himalayas.app/companies/acme-labs/jobs/staff-ai-engineer') {
    pass('parseHimalayasResponse maps applicationLink to url');
  } else {
    fail(`row 0 url = ${JSON.stringify(jobs[0]?.url)}`);
  }

  if (jobs[0]?.postedAt === 1782538666 * 1000) {
    pass('parseHimalayasResponse converts epoch seconds pubDate -> postedAt ms');
  } else {
    fail(`row 0 postedAt = ${JSON.stringify(jobs[0]?.postedAt)}`);
  }

  if (jobs[1]?.url === 'https://himalayas.app/companies/fallback-co/jobs/product-manager') {
    pass('parseHimalayasResponse falls back to guid when applicationLink is missing');
  } else {
    fail(`row 1 url = ${JSON.stringify(jobs[1]?.url)}`);
  }

  if (jobs[1]?.postedAt === Date.parse('2026-01-02T09:00:00Z')) {
    pass('parseHimalayasResponse parses string pubDate -> postedAt');
  } else {
    fail(`row 1 postedAt = ${JSON.stringify(jobs[1]?.postedAt)}`);
  }

  if (parseHimalayasResponse({}).length === 0 && parseHimalayasResponse(null).length === 0) {
    pass('parseHimalayasResponse empty / non-object payload -> empty result (no crash)');
  } else {
    fail('parseHimalayasResponse invalid payload should yield empty result');
  }

  let capturedUrl = null;
  let capturedOpts = null;
  const fetched = await himalayas.fetch(
    { name: 'Himalayas', provider: 'himalayas' },
    { fetchJson: async (url, opts) => { capturedUrl = url; capturedOpts = opts; return sample; } },
  );

  if (capturedUrl === 'https://himalayas.app/jobs/api?limit=50') {
    pass('himalayas.fetch() requests the pinned API URL');
  } else {
    fail(`himalayas.fetch() requested ${JSON.stringify(capturedUrl)}`);
  }

  if (capturedOpts && capturedOpts.redirect === 'error') {
    pass('himalayas.fetch() passes redirect:"error" to fetchJson');
  } else {
    fail(`himalayas.fetch() should pass redirect:"error", got: ${JSON.stringify(capturedOpts)}`);
  }

  if (fetched[0]?.company === 'Acme Labs' && fetched[0]?.title === 'Staff AI Engineer') {
    pass('provider: himalayas config returns normalized jobs');
  } else {
    fail(`himalayas.fetch() normalized row = ${JSON.stringify(fetched[0])}`);
  }
} catch (e) {
  fail(`himalayas provider tests crashed: ${e.message}`);
}

// ── Search mode (`himalayas:` block) ──────────────────────────────────────
//
// tests/fixtures/himalayas-search-page.json is page 1 of a live
// GET /jobs/api/search?q=engineering%20manager&country=CA, recorded
// 2026-09-24. The envelope (comments, updatedAt, offset, limit, totalCount)
// and every job key/value type are as served; the jobs array was trimmed from
// 20 rows to 4 (worldwide [], single-country, multi-country, a raw "&" title)
// and company names, slugs, links and descriptions were made fictional.

console.log('\nProvider — himalayas (search mode)');

try {
  const himalayasModule = await import(pathToFileURL(join(ROOT, 'providers/himalayas.mjs')).href);
  const himalayas = himalayasModule.default;
  const { parseHimalayasConfig, buildSearchUrl } = himalayasModule;
  const fixture = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/himalayas-search-page.json'), 'utf-8'));

  // A 20-row page cloned from a recorded job, with unique posting URLs.
  const makePage = ({ page, total, count = 20, tag = 'q' }) => ({
    ...fixture,
    offset: (page - 1) * 20,
    totalCount: total,
    jobs: Array.from({ length: count }, (_, i) => {
      const link = `https://himalayas.app/companies/exampleco/jobs/${tag}-${page}-${i}`;
      return { ...fixture.jobs[2], title: `Engineering Manager ${tag} ${page}-${i}`, applicationLink: link, guid: link };
    }),
  });

  // Mock transport: `respond(url)` returns the body or throws. Records every
  // request and every ctx.sleep so no test waits on a wall clock.
  const makeCtx = (respond, extra = {}) => {
    const calls = [];
    const sleeps = [];
    const ctx = {
      fetchJson: async (url, opts) => {
        calls.push({ url: new URL(url), opts });
        return respond(new URL(url));
      },
      sleep: async (ms) => { sleeps.push(ms); },
      ...extra,
    };
    return { ctx, calls, sleeps };
  };

  const run = async (entry, ctx) => {
    const orig = console.error;
    const warnings = [];
    console.error = (...args) => warnings.push(args.join(' '));
    try {
      return { jobs: await himalayas.fetch(entry, ctx), warnings };
    } catch (error) {
      return { error, warnings };
    } finally {
      console.error = orig;
    }
  };

  const httpError = (status) => Object.assign(new Error(`HTTP ${status}`), { status });
  const entryWith = (himalayasCfg, extra = {}) => ({ name: 'Himalayas', provider: 'himalayas', himalayas: himalayasCfg, ...extra });

  // parseHimalayasConfig
  if (parseHimalayasConfig({ name: 'H', provider: 'himalayas' }) === null
    && parseHimalayasConfig({ name: 'H', provider: 'himalayas', himalayas: null }) === null) {
    pass('parseHimalayasConfig: no himalayas: block -> null (browse feed)');
  } else {
    fail('parseHimalayasConfig should return null without a himalayas: block');
  }

  const cfg = parseHimalayasConfig(entryWith({
    queries: ['  engineering manager ', '', 42, 'Engineering Manager', 'software development manager'],
    country: ' CA ',
  }));
  if (JSON.stringify(cfg) === JSON.stringify({ queries: ['engineering manager', 'software development manager'], country: 'CA', maxPages: 10 })) {
    pass('parseHimalayasConfig trims, drops blank/non-string, dedups queries case-insensitively; default max_pages 10');
  } else {
    fail(`parseHimalayasConfig returned ${JSON.stringify(cfg)}`);
  }

  if (JSON.stringify(parseHimalayasConfig(entryWith({ queries: 'staff engineer' })).queries) === '["staff engineer"]') {
    pass('parseHimalayasConfig accepts a single string for queries');
  } else {
    fail('parseHimalayasConfig should accept queries: "<string>"');
  }

  if (JSON.stringify(parseHimalayasConfig(entryWith({ country: 'CA' }))) === JSON.stringify({ queries: [''], country: 'CA', maxPages: 10 })) {
    pass('parseHimalayasConfig: country with no queries -> one country-only sweep');
  } else {
    fail(`country-only config = ${JSON.stringify(parseHimalayasConfig(entryWith({ country: 'CA' })))}`);
  }

  const pagesFor = (himalayasCfg, extra) => parseHimalayasConfig(entryWith(himalayasCfg, extra)).maxPages;
  const pageCases = [
    [pagesFor({ country: 'CA', max_pages: 25 }), 25, 'nested max_pages'],
    [pagesFor({ country: 'CA', max_pages: 500 }), 50, 'nested max_pages capped at 50'],
    [pagesFor({ country: 'CA' }, { max_pages: 7 }), 7, 'entry-level max_pages fallback'],
    [pagesFor({ country: 'CA', max_pages: 4 }, { max_pages: 7 }), 4, 'nested max_pages wins over entry-level'],
    [pagesFor({ country: 'CA', max_pages: 0 }), 10, 'max_pages 0 -> default'],
    [pagesFor({ country: 'CA', max_pages: -3 }), 10, 'negative max_pages -> default'],
    [pagesFor({ country: 'CA', max_pages: 2.5 }), 10, 'fractional max_pages -> default'],
    [pagesFor({ country: 'CA', max_pages: '5' }), 10, 'string max_pages -> default'],
  ];
  const badPages = pageCases.filter(([got, want]) => got !== want);
  if (badPages.length === 0) pass('parseHimalayasConfig resolves max_pages (nested > entry-level > default 10, cap 50, junk ignored)');
  else fail(`max_pages cases wrong: ${badPages.map(([got, want, label]) => `${label}: got ${got}, want ${want}`).join('; ')}`);

  const throwsFor = (himalayasCfg) => {
    try { parseHimalayasConfig(entryWith(himalayasCfg)); return null; } catch (e) { return e.message; }
  };
  const noSearch = throwsFor({ queries: [' '], max_pages: 3 });
  if (noSearch && /no queries and no country/.test(noSearch) && noSearch.includes('"Himalayas"')) {
    pass('parseHimalayasConfig throws (naming the entry) on a block with neither queries nor country');
  } else {
    fail(`empty search block should throw, got ${JSON.stringify(noSearch)}`);
  }
  if ([['engineering manager'], 'engineering manager', true].every(v => /must be a mapping/.test(throwsFor(v) || ''))) {
    pass('parseHimalayasConfig throws on a non-mapping himalayas: value');
  } else {
    fail('non-mapping himalayas: value should throw');
  }

  // buildSearchUrl
  if (buildSearchUrl('engineering manager', 'CA', 2) === 'https://himalayas.app/jobs/api/search?q=engineering+manager&country=CA&page=2'
    && buildSearchUrl('', 'CA', 1) === 'https://himalayas.app/jobs/api/search?country=CA&page=1') {
    pass('buildSearchUrl encodes q / country / page and omits an empty q');
  } else {
    fail(`buildSearchUrl -> ${buildSearchUrl('engineering manager', 'CA', 2)} | ${buildSearchUrl('', 'CA', 1)}`);
  }
  const hostile = 'CA&q=x#frag/../@evil.example';
  const hostileUrl = new URL(buildSearchUrl('a/b?c', hostile, 1));
  if (hostileUrl.hostname === 'himalayas.app' && hostileUrl.pathname === '/jobs/api/search'
    && hostileUrl.searchParams.get('country') === hostile && hostileUrl.searchParams.get('q') === 'a/b?c') {
    pass('buildSearchUrl keeps config values inside the query string (host/path fixed)');
  } else {
    fail(`hostile config escaped the query string: ${hostileUrl.href}`);
  }

  // fetch() against the recorded fixture
  {
    const { ctx, calls } = makeCtx((url) => (url.searchParams.get('page') === '1' ? fixture : { ...fixture, offset: 20, jobs: [] }));
    const { jobs, warnings, error } = await run(entryWith({ queries: ['engineering manager'], country: 'CA' }), ctx);
    if (error) throw error;

    if (calls[0]?.url.href === 'https://himalayas.app/jobs/api/search?q=engineering+manager&country=CA&page=1') {
      pass('search mode requests /jobs/api/search with q, country and page=1');
    } else {
      fail(`first search request was ${calls[0]?.url.href}`);
    }
    if (calls.length > 0 && calls.every(c => c.opts?.redirect === 'error')) {
      pass('search mode passes redirect:"error" on every request');
    } else {
      fail(`search request opts: ${JSON.stringify(calls.map(c => c.opts))}`);
    }
    if (calls.length === 2 && warnings.length === 0) {
      pass('an empty page ends the query even when totalCount (354) claims more, with no cap warning');
    } else {
      fail(`expected 2 requests / 0 warnings, got ${calls.length} / ${JSON.stringify(warnings)}`);
    }

    const [worldwide, multi, single, amp] = jobs;
    if (jobs.length === 4
      && worldwide.title === 'Engineering Manager - Desktop Apps' && worldwide.company === 'Acme Linux'
      && worldwide.url === 'https://himalayas.app/companies/acme-linux/jobs/engineering-manager-desktop-apps'
      && worldwide.postedAt === 1789858244 * 1000) {
      pass('recorded search rows normalize (title, company, applicationLink url, epoch-seconds pubDate)');
    } else {
      fail(`recorded rows normalized to ${JSON.stringify(jobs)}`);
    }
    if (worldwide?.location === '' && single?.location === 'Canada'
      && multi?.location === 'Canada, Germany, India, Netherlands, United Kingdom, United States') {
      pass('locationRestrictions: [] -> "" (worldwide), lists joined');
    } else {
      fail(`locations: ${JSON.stringify(jobs.map(j => j.location))}`);
    }
    if (amp?.title === 'Engineering Manager, Data & Machine Learning') {
      pass('a raw "&" in a JSON title is kept as-is');
    } else {
      fail(`amp title = ${JSON.stringify(amp?.title)}`);
    }
  }

  // Pagination: totalCount stops the query
  {
    const { ctx, calls } = makeCtx((url) => {
      const page = Number(url.searchParams.get('page'));
      return makePage({ page, total: 45, count: page === 3 ? 5 : 20 });
    });
    const { jobs, error } = await run(entryWith({ queries: ['engineering manager'] }), ctx);
    if (!error && calls.length === 3 && jobs.length === 45) pass('pagination stops once offset + rows reaches totalCount (3 requests for 45)');
    else fail(`totalCount stop: ${calls.length} requests, ${jobs?.length} jobs, error ${error?.message}`);
  }

  // Pagination: short page stops the query when totalCount is absent
  {
    const { ctx, calls } = makeCtx((url) => {
      const page = Number(url.searchParams.get('page'));
      return makePage({ page, total: undefined, count: page === 2 ? 7 : 20 });
    });
    const { jobs, error } = await run(entryWith({ queries: ['engineering manager'] }), ctx);
    if (!error && calls.length === 2 && jobs.length === 27) pass('without totalCount, a short page ends the query');
    else fail(`short-page stop: ${calls.length} requests, ${jobs?.length} jobs, error ${error?.message}`);
  }

  // Pagination: DEFAULT_MAX_PAGES bounds a board that reports more
  {
    const { ctx, calls } = makeCtx((url) => makePage({ page: Number(url.searchParams.get('page')), total: 5000 }));
    const { jobs, warnings, error } = await run(entryWith({ queries: ['engineering manager'] }), ctx);
    if (!error && calls.length === 10 && jobs.length === 200) pass('DEFAULT_MAX_PAGES (10) stops the query although totalCount reports 5000');
    else fail(`default cap: ${calls.length} requests, ${jobs?.length} jobs, error ${error?.message}`);
    if (warnings.length === 1 && /max_pages=10/.test(warnings[0]) && /200 of 5000/.test(warnings[0]) && /raise himalayas\.max_pages/.test(warnings[0])) {
      pass('the cap truncation warns with the fix (raise himalayas.max_pages)');
    } else {
      fail(`cap warning: ${JSON.stringify(warnings)}`);
    }
  }
  {
    const { ctx, calls } = makeCtx((url) => makePage({ page: Number(url.searchParams.get('page')), total: 5000 }));
    await run(entryWith({ queries: ['engineering manager'], max_pages: 3 }), ctx);
    if (calls.length === 3) pass('himalayas.max_pages: 3 stops each query after 3 pages');
    else fail(`max_pages 3 made ${calls.length} requests`);
  }

  // Several queries: each paged from 1, deduplicated by URL, paced
  {
    const { ctx, calls, sleeps } = makeCtx((url) => {
      const q = url.searchParams.get('q');
      const page = Number(url.searchParams.get('page'));
      const body = makePage({ page, total: 25, count: page === 1 ? 20 : 5, tag: q === 'engineering manager' ? 'em' : 'sdm' });
      // Query 2's first row is the same posting query 1 already returned.
      if (q === 'software development manager' && page === 1) body.jobs[0] = makePage({ page: 1, total: 25, tag: 'em' }).jobs[0];
      return body;
    });
    const { jobs, error } = await run(entryWith({ queries: ['engineering manager', 'software development manager'], country: 'CA' }), ctx);
    const sequence = calls.map(c => `${c.url.searchParams.get('q')}#${c.url.searchParams.get('page')}`).join(',');
    if (!error && sequence === 'engineering manager#1,engineering manager#2,software development manager#1,software development manager#2') {
      pass('each query is paginated separately, starting from page 1');
    } else {
      fail(`query/page sequence: ${sequence} (error ${error?.message})`);
    }
    if (jobs?.length === 49 && new Set(jobs.map(j => j.url)).size === 49) pass('postings returned by two queries are deduplicated by URL');
    else fail(`multi-query dedup: ${jobs?.length} jobs`);
    if (calls.every(c => c.url.searchParams.get('country') === 'CA')) pass('country is sent with every query');
    else fail('country missing on some requests');
    if (sleeps.length === calls.length - 1 && sleeps.every(ms => ms === 250)) pass('a 250ms pause precedes every request after the first');
    else fail(`sleeps: ${JSON.stringify(sleeps)} for ${calls.length} requests`);
  }

  // Health probe: ctx.maxPages
  {
    const { ctx, calls } = makeCtx((url) => makePage({ page: Number(url.searchParams.get('page')), total: 5000 }), { maxPages: 1 });
    const { warnings, error } = await run(entryWith({ queries: ['engineering manager', 'software development manager'] }), ctx);
    if (!error && calls.length === 1 && calls[0].url.searchParams.get('q') === 'engineering manager' && warnings.length === 0) {
      pass('ctx.maxPages: 1 -> exactly one request (first query, page 1), no cap warning');
    } else {
      fail(`probe: ${calls.length} requests, warnings ${JSON.stringify(warnings)}, error ${error?.message}`);
    }
  }
  {
    class BudgetReached extends Error {}
    const budget = new BudgetReached('probe budget');
    const { ctx } = makeCtx(() => { throw budget; }, { maxPages: 1 });
    const { error } = await run(entryWith({ queries: ['engineering manager', 'software development manager'] }), ctx);
    if (error === budget) pass('while probing, a fetch rejection propagates unwrapped (same error object)');
    else fail(`probe rejection was ${error ? `rewrapped: ${error.message}` : 'swallowed'}`);
  }

  // Transient failure mid-query: keep earlier pages, warn, no cap warning
  {
    const { ctx, calls } = makeCtx((url) => {
      const page = Number(url.searchParams.get('page'));
      if (page === 2) throw httpError(500);
      return makePage({ page, total: 100 });
    });
    const { jobs, warnings, error } = await run(entryWith({ queries: ['engineering manager'] }), ctx);
    if (!error && jobs.length === 20 && calls.length === 4) {
      pass('a 500 on page 2 that retry cannot clear keeps page 1 (1 + 3 attempts)');
    } else {
      fail(`page-2 failure: ${jobs?.length} jobs, ${calls.length} requests, error ${error?.message}`);
    }
    if (warnings.length === 1 && /failed on page 2 \(HTTP 500\)/.test(warnings[0]) && /keeping pages 1-1/.test(warnings[0])
      && !warnings.some(w => /max_pages/.test(w))) {
      pass('the mid-query failure warns, and the "raise max_pages" warning does not fire');
    } else {
      fail(`page-2 failure warnings: ${JSON.stringify(warnings)}`);
    }
  }

  // One query down, one up -> keep the live one; all down -> throw
  {
    const { ctx } = makeCtx((url) => {
      if (url.searchParams.get('q') === 'engineering manager') throw httpError(503);
      return makePage({ page: Number(url.searchParams.get('page')), total: 3, count: 3, tag: 'sdm' });
    });
    const { jobs, warnings, error } = await run(entryWith({ queries: ['engineering manager', 'software development manager'] }), ctx);
    if (!error && jobs.length === 3 && warnings.some(w => /"engineering manager": HTTP 503 - skipped, other queries kept/.test(w))) {
      pass('a query whose first page fails is skipped with a warning; the others are kept');
    } else {
      fail(`one-query outage: ${jobs?.length} jobs, warnings ${JSON.stringify(warnings)}, error ${error?.message}`);
    }
  }
  {
    const { ctx } = makeCtx(() => { throw httpError(503); });
    const { error } = await run(entryWith({ queries: ['engineering manager', 'software development manager'] }), ctx);
    if (error && /all 2 search queries failed/.test(error.message) && /HTTP 503/.test(error.message)) {
      pass('every query failing throws (a dead endpoint is an error, not an empty board)');
    } else {
      fail(`total outage should throw, got ${error ? error.message : 'no error'}`);
    }
  }

  // Contentless vs unrecognised bodies
  {
    const results = [];
    for (const body of [null, {}, { jobs: null }, []]) {
      const { ctx, calls } = makeCtx(() => body);
      const { jobs, error } = await run(entryWith({ queries: ['engineering manager'] }), ctx);
      results.push(!error && Array.isArray(jobs) && jobs.length === 0 && calls.length === 1);
    }
    if (results.every(Boolean)) pass('contentless search bodies (null / {} / {jobs:null} / []) -> [] without throwing');
    else fail(`contentless bodies: ${JSON.stringify(results)}`);
  }
  {
    const outcomes = [];
    for (const body of [{ results: [], total: 0 }, { jobs: 'none' }]) {
      const { ctx } = makeCtx(() => body);
      const { error } = await run(entryWith({ queries: ['engineering manager'] }), ctx);
      outcomes.push(error ? error.message : 'no error');
    }
    if (/unexpected search response for "engineering manager".*keys: \[results, total\]/.test(outcomes[0]) && /unexpected search response/.test(outcomes[1])) {
      pass('an unrecognised search envelope throws, naming the keys it got');
    } else {
      fail(`unrecognised envelopes: ${JSON.stringify(outcomes)}`);
    }
  }

  // A misconfigured block fails before any request
  {
    const { ctx, calls } = makeCtx(() => fixture);
    const { error } = await run(entryWith({ queries: [] }), ctx);
    if (error && /no queries and no country/.test(error.message) && calls.length === 0) {
      pass('fetch() rejects a himalayas: block with nothing to search before any request');
    } else {
      fail(`misconfigured block: error ${error?.message}, ${calls.length} requests`);
    }
  }
} catch (e) {
  fail(`himalayas search-mode tests crashed: ${e.message}`);
}
