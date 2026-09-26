// tests/providers/jobicy.test.mjs — moved verbatim from test-all.mjs (#1440);
// entity-decoding case and filtered-mode section added below.
import { pass, fail, ROOT } from '../helpers.mjs';
import { readFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — jobicy');

try {
  const jobicyModule = await import(pathToFileURL(join(ROOT, 'providers/jobicy.mjs')).href);
  const jobicy = jobicyModule.default;
  const { parseJobicyResponse } = jobicyModule;

  if (jobicy.id === 'jobicy') pass('jobicy.id is "jobicy"');
  else fail(`jobicy.id is ${JSON.stringify(jobicy.id)}`);

  const hit = jobicy.detect({ name: 'Jobicy Board', provider: 'jobicy' });
  if (hit && hit.url === 'https://jobicy.com/api/v2/remote-jobs?count=50') {
    pass('jobicy.detect() claims explicit provider config');
  } else {
    fail(`jobicy.detect() returned ${JSON.stringify(hit)}`);
  }

  if (jobicy.detect({ name: 'Remote Board', provider: 'remoteok' }) === null) {
    pass('jobicy.detect() ignores other provider ids');
  } else {
    fail('jobicy.detect() should only claim provider: jobicy');
  }

  const sample = {
    jobs: [
      {
        jobTitle: 'Senior AI Engineer',
        companyName: 'Acme Corp',
        jobGeo: 'Worldwide',
        url: 'https://jobicy.com/jobs/senior-ai-engineer',
        pubDate: '2026-06-27T10:00:00',
      },
      {
        jobTitle: 'Staff Backend Developer',
        companyName: 'Globex',
        jobGeo: 'Europe',
        url: 'https://jobicy.com/jobs/staff-backend-developer',
        pubDate: '2026-06-25T12:00:00Z',
      },
      {
        jobTitle: 'Role With Missing URL',
        companyName: 'Incomplete',
        jobGeo: 'USA',
        pubDate: '2026-06-24T08:00:00Z',
      },
      {
        jobTitle: 'Role With Invalid URL',
        companyName: 'Invalid',
        url: 'not-a-valid-url',
        jobGeo: 'USA',
      },
      {
        jobTitle: '',
        companyName: 'Empty Title',
        url: 'https://jobicy.com/jobs/empty-title',
        jobGeo: 'USA',
      }
    ]
  };

  const jobs = parseJobicyResponse(sample, 'Jobicy Board');

  if (jobs.length === 2) pass('parseJobicyResponse keeps 2 jobs (drops missing/invalid url and empty title)');
  else fail(`parseJobicyResponse returned ${jobs.length} jobs (expected 2)`);

  if (jobs[0]?.company === 'Acme Corp' && jobs[0]?.title === 'Senior AI Engineer') {
    pass('parseJobicyResponse maps jobTitle -> title, companyName -> company');
  } else {
    fail(`row 0 title/company = ${JSON.stringify({ title: jobs[0]?.title, company: jobs[0]?.company })}`);
  }

  if (jobs[0]?.url === 'https://jobicy.com/jobs/senior-ai-engineer') {
    pass('parseJobicyResponse maps url to url');
  } else {
    fail(`row 0 url = ${JSON.stringify(jobs[0]?.url)}`);
  }

  if (jobs[0]?.location === 'Worldwide') {
    pass('parseJobicyResponse maps jobGeo to location');
  } else {
    fail(`row 0 location = ${JSON.stringify(jobs[0]?.location)}`);
  }

  if (jobs[0]?.postedAt === Date.parse('2026-06-27T10:00:00')) {
    pass('parseJobicyResponse parses pubDate -> postedAt');
  } else {
    fail(`row 0 postedAt = ${JSON.stringify(jobs[0]?.postedAt)}`);
  }

  if (jobs[1]?.company === 'Globex' && jobs[1]?.title === 'Staff Backend Developer') {
    pass('parseJobicyResponse parses second job correctly');
  } else {
    fail(`row 1 = ${JSON.stringify(jobs[1])}`);
  }

  if (parseJobicyResponse('', 'X').length === 0 && parseJobicyResponse(null, 'X').length === 0) {
    pass('parseJobicyResponse empty / non-object payload -> empty result (no crash)');
  } else {
    fail('parseJobicyResponse empty / non-object payload should yield empty result');
  }

  let capturedUrl = null;
  let capturedOpts = null;
  const fetched = await jobicy.fetch(
    { name: 'Jobicy Board', provider: 'jobicy' },
    { fetchJson: async (url, opts) => { capturedUrl = url; capturedOpts = opts; return sample; } },
  );

  if (capturedUrl === 'https://jobicy.com/api/v2/remote-jobs?count=50') {
    pass('jobicy.fetch() requests the pinned JSON feed URL');
  } else {
    fail(`jobicy.fetch() requested ${JSON.stringify(capturedUrl)}`);
  }

  if (capturedOpts && capturedOpts.redirect === 'error') {
    pass('jobicy.fetch() passes redirect:"error" to fetchJson');
  } else {
    fail(`jobicy.fetch() should pass redirect:"error", got: ${JSON.stringify(capturedOpts)}`);
  }

  if (fetched[0]?.company === 'Acme Corp' && fetched[0]?.title === 'Senior AI Engineer') {
    pass('provider: jobicy config returns normalized jobs');
  } else {
    fail(`jobicy.fetch() normalized row = ${JSON.stringify(fetched[0])}`);
  }

  // Live data carries WordPress-encoded company names ("hims &#038; hers").
  const encoded = parseJobicyResponse({
    jobs: [{ jobTitle: 'Data &amp; ML Lead', companyName: 'Acme &#038; Sons', url: 'https://jobicy.com/jobs/1-data-ml-lead', jobGeo: 'Canada' }],
  });
  if (encoded[0]?.company === 'Acme & Sons' && encoded[0]?.title === 'Data & ML Lead') {
    pass('parseJobicyResponse decodes HTML entities in companyName and jobTitle');
  } else {
    fail(`entity decoding: ${JSON.stringify(encoded[0])}`);
  }

  let feedCalls = 0;
  await jobicy.fetch({ name: 'Jobicy Board', provider: 'jobicy' }, { maxPages: 1, fetchJson: async () => { feedCalls++; return sample; } });
  if (feedCalls === 1) pass('newest-jobs feed: ctx.maxPages: 1 -> exactly one request');
  else fail(`newest-jobs feed probe made ${feedCalls} requests`);

} catch (e) {
  fail(`jobicy provider tests crashed: ${e.message}`);
}

// ── Filtered mode (`jobicy:` block) ───────────────────────────────────────
//
// tests/fixtures/jobicy-search-page.json is a live
// GET /api/v2/remote-jobs?count=200&geo=canada&tag=engineering%20manager,
// recorded 2026-09-25 02:24 UTC. The envelope (apiVersion, friendlyNotice,
// appliedFilters, ...) and every job key/value type are as served, jobGeo's
// double spaces included; the jobs array was trimmed from 117 rows to 4
// (Anywhere, Canada with a CAD salary, a two-country list with an
// entity-encoded company, a five-region list), jobCount set to match, and
// company names, ids, slugs, logos and descriptions made fictional.

console.log('\nProvider — jobicy (filtered mode)');

try {
  const jobicyModule = await import(pathToFileURL(join(ROOT, 'providers/jobicy.mjs')).href);
  const jobicy = jobicyModule.default;
  const { parseJobicyConfig, buildSearchUrl } = jobicyModule;
  const fixture = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/jobicy-search-page.json'), 'utf-8'));

  // A response of `count` rows cloned from a recorded job, with unique posting URLs.
  const makeBody = ({ count, tag = 't' }) => ({
    ...fixture,
    jobCount: count,
    jobs: Array.from({ length: count }, (_, i) => ({
      ...fixture.jobs[1],
      id: 800000 + i,
      jobTitle: `Engineering Manager ${tag} ${i}`,
      url: `https://jobicy.com/jobs/${tag}-${i}`,
    })),
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
      return { jobs: await jobicy.fetch(entry, ctx), warnings };
    } catch (error) {
      return { error, warnings };
    } finally {
      console.error = orig;
    }
  };

  const httpError = (status, body = '') => Object.assign(new Error(`HTTP ${status}`), { status, body });
  const entryWith = (jobicyCfg, extra = {}) => ({ name: 'Jobicy', provider: 'jobicy', jobicy: jobicyCfg, ...extra });

  // parseJobicyConfig
  if (parseJobicyConfig({ name: 'J', provider: 'jobicy' }) === null
    && parseJobicyConfig({ name: 'J', provider: 'jobicy', jobicy: null }) === null) {
    pass('parseJobicyConfig: no jobicy: block -> null (newest-jobs feed)');
  } else {
    fail('parseJobicyConfig should return null without a jobicy: block');
  }

  const cfg = parseJobicyConfig(entryWith({
    tags: ['  engineering manager ', '', 42, 'Engineering Manager', 'software development manager'],
    geo: ' canada ',
    industry: ' engineering ',
  }));
  if (JSON.stringify(cfg) === JSON.stringify({ tags: ['engineering manager', 'software development manager'], geo: 'canada', industry: 'engineering' })) {
    pass('parseJobicyConfig trims, drops blank/non-string, dedups tags case-insensitively; trims geo and industry');
  } else {
    fail(`parseJobicyConfig returned ${JSON.stringify(cfg)}`);
  }

  if (JSON.stringify(parseJobicyConfig(entryWith({ tags: 'staff engineer' })).tags) === '["staff engineer"]') {
    pass('parseJobicyConfig accepts a single string for tags');
  } else {
    fail('parseJobicyConfig should accept tags: "<string>"');
  }

  if (JSON.stringify(parseJobicyConfig(entryWith({ geo: 'canada' }))) === JSON.stringify({ tags: [''], geo: 'canada', industry: '' })
    && JSON.stringify(parseJobicyConfig(entryWith({ industry: 'engineering' })).tags) === '[""]') {
    pass('parseJobicyConfig: geo or industry with no tags -> one untagged request');
  } else {
    fail(`geo-only config = ${JSON.stringify(parseJobicyConfig(entryWith({ geo: 'canada' })))}`);
  }

  const throwsFor = (jobicyCfg) => {
    try { parseJobicyConfig(entryWith(jobicyCfg)); return null; } catch (e) { return e.message; }
  };
  const noFilter = throwsFor({ tags: [' '] });
  if (noFilter && /no tags, geo or industry/.test(noFilter) && noFilter.includes('"Jobicy"')) {
    pass('parseJobicyConfig throws (naming the entry) on a block with no tags, geo or industry');
  } else {
    fail(`empty filter block should throw, got ${JSON.stringify(noFilter)}`);
  }
  const shortTag = throwsFor({ tags: ['engineering manager', 'em'], geo: 'canada' });
  const longTag = throwsFor({ tags: ['x'.repeat(51)] });
  if (/tag "em" is 2 characters .* accepts 3-50/.test(shortTag || '') && /is 51 characters/.test(longTag || '')
    && throwsFor({ tags: ['abc', 'y'.repeat(50)] }) === null) {
    pass('parseJobicyConfig throws on a tag outside the API\'s 3-50 characters (3 and 50 accepted)');
  } else {
    fail(`tag length: short ${JSON.stringify(shortTag)}, long ${JSON.stringify(longTag)}`);
  }
  if ([['engineering manager'], 'engineering manager', true].every(v => /must be a mapping/.test(throwsFor(v) || ''))) {
    pass('parseJobicyConfig throws on a non-mapping jobicy: value');
  } else {
    fail('non-mapping jobicy: value should throw');
  }

  // buildSearchUrl
  if (buildSearchUrl('engineering manager', 'canada', '') === 'https://jobicy.com/api/v2/remote-jobs?count=200&geo=canada&tag=engineering+manager'
    && buildSearchUrl('', 'canada', 'engineering') === 'https://jobicy.com/api/v2/remote-jobs?count=200&geo=canada&industry=engineering'
    && buildSearchUrl('"engineering manager"', '', '') === 'https://jobicy.com/api/v2/remote-jobs?count=200&tag=%22engineering+manager%22') {
    pass('buildSearchUrl sends count=200 and encodes geo / industry / tag, omitting empty ones');
  } else {
    fail(`buildSearchUrl -> ${buildSearchUrl('engineering manager', 'canada', '')} | ${buildSearchUrl('', 'canada', 'engineering')}`);
  }
  const hostile = 'canada&count=5#frag/../@evil.example';
  const hostileUrl = new URL(buildSearchUrl('a/b?c&page=2', hostile, 'x&y'));
  if (hostileUrl.hostname === 'jobicy.com' && hostileUrl.pathname === '/api/v2/remote-jobs'
    && hostileUrl.searchParams.get('geo') === hostile && hostileUrl.searchParams.get('tag') === 'a/b?c&page=2'
    && hostileUrl.searchParams.get('industry') === 'x&y' && hostileUrl.searchParams.getAll('count').join() === '200'
    && !hostileUrl.searchParams.has('page')) {
    pass('buildSearchUrl keeps config values inside the query string (host, path and count fixed)');
  } else {
    fail(`hostile config escaped the query string: ${hostileUrl.href}`);
  }

  // fetch() against the recorded fixture
  {
    const { ctx, calls } = makeCtx(() => fixture);
    const { jobs, warnings, error } = await run(entryWith({ tags: ['engineering manager'], geo: 'canada' }), ctx);
    if (error) throw error;

    if (calls.length === 1 && calls[0].url.href === 'https://jobicy.com/api/v2/remote-jobs?count=200&geo=canada&tag=engineering+manager') {
      pass('filtered mode makes one request per tag: count=200, geo, tag (no pagination)');
    } else {
      fail(`filtered requests: ${calls.map(c => c.url.href).join(' | ')}`);
    }
    if (calls.length > 0 && calls.every(c => c.opts?.redirect === 'error')) {
      pass('filtered mode passes redirect:"error" on every request');
    } else {
      fail(`filtered request opts: ${JSON.stringify(calls.map(c => c.opts))}`);
    }
    if (warnings.length === 0) pass('a response under the 200-row cap does not warn');
    else fail(`unexpected warnings: ${JSON.stringify(warnings)}`);

    const [anywhere, canada, twoCountry, fiveRegion] = jobs;
    if (jobs.length === 4
      && anywhere.title === 'Engineering Manager - MLOps & Analytics' && anywhere.company === 'Acme Linux'
      && anywhere.url === 'https://jobicy.com/jobs/900101-engineering-manager-mlops-analytics'
      && anywhere.postedAt === Date.parse('2026-09-24T04:55:10+00:00')) {
      pass('recorded rows normalize (jobTitle with a raw "&", companyName, url, ISO pubDate)');
    } else {
      fail(`recorded rows normalized to ${JSON.stringify(jobs)}`);
    }
    if (anywhere?.location === 'Anywhere' && canada?.location === 'Canada'
      && twoCountry?.location === 'Canada,  USA' && fiveRegion?.location === 'APAC,  EMEA,  LATAM,  Canada,  USA') {
      pass('jobGeo passes through as location (Anywhere = worldwide)');
    } else {
      fail(`locations: ${JSON.stringify(jobs.map(j => j.location))}`);
    }
    if (twoCountry?.company === 'Acme & Sons') pass('a recorded entity-encoded companyName ("&#038;") is decoded');
    else fail(`encoded company = ${JSON.stringify(twoCountry?.company)}`);
  }

  // Several tags: one request each, deduplicated by URL, paced
  {
    const { ctx, calls, sleeps } = makeCtx((url) => {
      const tag = url.searchParams.get('tag');
      const body = makeBody({ count: 5, tag: tag === 'engineering manager' ? 'em' : tag === 'engineering team lead' ? 'tl' : 'sdm' });
      // Tag 2's first row is the same posting tag 1 already returned.
      if (tag === 'engineering team lead') body.jobs[0] = makeBody({ count: 1, tag: 'em' }).jobs[0];
      return body;
    });
    const { jobs, error } = await run(entryWith({ tags: ['engineering manager', 'engineering team lead', 'software development manager'], geo: 'canada' }), ctx);
    const sequence = calls.map(c => c.url.searchParams.get('tag')).join(',');
    if (!error && sequence === 'engineering manager,engineering team lead,software development manager') {
      pass('each tag gets exactly one request, in config order');
    } else {
      fail(`tag sequence: ${sequence} (error ${error?.message})`);
    }
    if (jobs?.length === 14 && new Set(jobs.map(j => j.url)).size === 14) pass('postings returned by two tags are deduplicated by URL');
    else fail(`multi-tag dedup: ${jobs?.length} jobs`);
    if (calls.every(c => c.url.searchParams.get('geo') === 'canada' && c.url.searchParams.get('count') === '200')) pass('geo and count=200 are sent with every tag');
    else fail('geo / count missing on some requests');
    if (sleeps.length === calls.length - 1 && sleeps.every(ms => ms === 250)) pass('a 250ms pause precedes every request after the first');
    else fail(`sleeps: ${JSON.stringify(sleeps)} for ${calls.length} requests`);
  }

  // The 200-row cap: no pagination to follow, so warn
  {
    const { ctx, calls } = makeCtx(() => makeBody({ count: 200 }));
    const { jobs, warnings, error } = await run(entryWith({ tags: ['engineering team lead'], geo: 'canada' }), ctx);
    if (!error && calls.length === 1 && jobs.length === 200) pass('a full 200-row response is not followed by a second request (the API rejects page/offset)');
    else fail(`cap: ${calls.length} requests, ${jobs?.length} jobs, error ${error?.message}`);
    if (warnings.length === 1 && /tag "engineering team lead" filled the API's 200-row cap/.test(warnings[0]) && /no pagination/.test(warnings[0])) {
      pass('a tag that fills the 200-row cap warns that matches were cut off');
    } else {
      fail(`cap warning: ${JSON.stringify(warnings)}`);
    }
  }

  // Health probe: ctx.maxPages
  {
    const { ctx, calls } = makeCtx(() => makeBody({ count: 200 }), { maxPages: 1 });
    const { warnings, error } = await run(entryWith({ tags: ['engineering manager', 'software development manager'], geo: 'canada' }), ctx);
    if (!error && calls.length === 1 && calls[0].url.searchParams.get('tag') === 'engineering manager' && warnings.length === 0) {
      pass('ctx.maxPages: 1 -> exactly one request (first tag), no cap warning');
    } else {
      fail(`probe: ${calls.length} requests, warnings ${JSON.stringify(warnings)}, error ${error?.message}`);
    }
  }
  {
    class BudgetReached extends Error {}
    const budget = new BudgetReached('probe budget');
    const { ctx } = makeCtx(() => { throw budget; }, { maxPages: 1 });
    const { error } = await run(entryWith({ tags: ['engineering manager', 'software development manager'] }), ctx);
    if (error === budget) pass('while probing, a fetch rejection propagates unwrapped (same error object)');
    else fail(`probe rejection was ${error ? `rewrapped: ${error.message}` : 'swallowed'}`);
  }

  // One tag down, others up -> keep the live ones; all down -> throw
  {
    const { ctx, calls } = makeCtx((url) => {
      if (url.searchParams.get('tag') === 'engineering manager') throw httpError(503);
      return makeBody({ count: 3, tag: 'sdm' });
    });
    const { jobs, warnings, error } = await run(entryWith({ tags: ['engineering manager', 'software development manager'] }), ctx);
    if (!error && jobs.length === 3 && calls.length === 4
      && warnings.length === 1 && /tag "engineering manager": HTTP 503 — skipped, other tags kept/.test(warnings[0])) {
      pass('a tag whose request still fails after retry (1 + 2 attempts) is skipped with a warning; the others are kept');
    } else {
      fail(`one-tag outage: ${jobs?.length} jobs, ${calls.length} requests, warnings ${JSON.stringify(warnings)}, error ${error?.message}`);
    }
  }
  {
    const { ctx } = makeCtx(() => { throw httpError(503); });
    const { error } = await run(entryWith({ tags: ['engineering manager', 'software development manager'] }), ctx);
    if (error && /all 2 filtered requests failed/.test(error.message) && /HTTP 503/.test(error.message)) {
      pass('every tag failing throws (a dead endpoint is an error, not an empty board)');
    } else {
      fail(`total outage should throw, got ${error ? error.message : 'no error'}`);
    }
  }
  {
    // The live API's answer to an unknown geo slug (recorded 2026-09-25).
    const badGeo = JSON.stringify({ success: false, error: "Invalid 'geo' value. This value must contain a predefined 'geoSlug'. See here: https://jobicy.com/api/v2/remote-jobs?get=locations" });
    const { ctx, calls } = makeCtx(() => { throw httpError(400, badGeo); });
    const { error } = await run(entryWith({ tags: ['engineering manager', 'software development manager'], geo: 'narnia' }), ctx);
    if (error && /HTTP 400: Invalid 'geo' value/.test(error.message) && calls.length === 2) {
      pass('a 400 is not retried, and the thrown error carries the API\'s own reason (bad geo slug)');
    } else {
      fail(`400 handling: ${calls.length} requests, error ${error ? error.message : 'none'}`);
    }
  }

  // Contentless vs unrecognised bodies
  {
    const results = [];
    const noMatch = { ...fixture, jobCount: 0, lastUpdate: '', jobs: [], message: 'No jobs found for the applied filters.' };
    for (const body of [null, {}, { jobs: null }, [], noMatch]) {
      const { ctx, calls } = makeCtx(() => body);
      const { jobs, error } = await run(entryWith({ tags: ['engineering manager'] }), ctx);
      results.push(!error && Array.isArray(jobs) && jobs.length === 0 && calls.length === 1);
    }
    if (results.every(Boolean)) pass('contentless bodies (null / {} / {jobs:null} / [] / the live no-match envelope) -> [] without throwing');
    else fail(`contentless bodies: ${JSON.stringify(results)}`);
  }
  {
    const outcomes = [];
    for (const body of [{ results: [], total: 0 }, { jobs: 'none' }, { success: false, error: 'boom' }]) {
      const { ctx } = makeCtx(() => body);
      const { error } = await run(entryWith({ tags: ['engineering manager'] }), ctx);
      outcomes.push(error ? error.message : 'no error');
    }
    if (/unexpected API response for tag "engineering manager".*keys: \[results, total\]/.test(outcomes[0])
      && /unexpected API response/.test(outcomes[1]) && /keys: \[success, error\]/.test(outcomes[2])) {
      pass('an unrecognised envelope throws, naming the keys it got');
    } else {
      fail(`unrecognised envelopes: ${JSON.stringify(outcomes)}`);
    }
  }

  // A misconfigured block fails before any request
  {
    const { ctx, calls } = makeCtx(() => fixture);
    const { error } = await run(entryWith({ tags: [] }), ctx);
    if (error && /no tags, geo or industry/.test(error.message) && calls.length === 0) {
      pass('fetch() rejects a jobicy: block with nothing to filter on before any request');
    } else {
      fail(`misconfigured block: error ${error?.message}, ${calls.length} requests`);
    }
  }
} catch (e) {
  fail(`jobicy filtered-mode tests crashed: ${e.message}`);
}
