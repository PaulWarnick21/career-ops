// tests/providers/ibm.test.mjs — moved verbatim from test-all.mjs (#1440).
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — ibm');

try {
  const ibmModule = await import(pathToFileURL(join(ROOT, 'providers/ibm.mjs')).href);
  const ibm = ibmModule.default;
  const { parseIbmResponse, buildPostFilter, buildQuery } = ibmModule;

  if (ibm.id === 'ibm') pass('ibm.id is "ibm"');
  else fail(`ibm.id is ${JSON.stringify(ibm.id)}`);

  // buildPostFilter — empty config yields no filter terms
  if (buildPostFilter({}).bool.must.length === 0) pass('buildPostFilter({}) → no must terms');
  else fail(`buildPostFilter({}) = ${JSON.stringify(buildPostFilter({}))}`);

  // buildPostFilter — country + categories produce the expected facet terms
  const pf = buildPostFilter({ country: 'Germany', categories: ['Software Engineering', 'Data & Analytics'] });
  const countryTerm = pf.bool.must.find(m => m.term && m.term.field_keyword_05);
  const catTerm = pf.bool.must.find(m => m.bool && m.bool.should);
  if (countryTerm?.term.field_keyword_05 === 'Germany' && catTerm?.bool.should.length === 2) {
    pass('buildPostFilter maps country → field_keyword_05 and categories → field_keyword_08 should[]');
  } else {
    fail(`buildPostFilter facets = ${JSON.stringify(pf)}`);
  }

  // buildPostFilter — sanitizes empty/non-string category entries
  const sanitized = buildPostFilter({ categories: ['Valid', '', '   ', 42, null] });
  const sanitizedShould = sanitized.bool.must.find(m => m.bool && m.bool.should)?.bool.should;
  if (sanitizedShould?.length === 1 && sanitizedShould[0].term.field_keyword_08 === 'Valid') {
    pass('buildPostFilter drops empty/non-string category entries');
  } else {
    fail(`buildPostFilter sanitization = ${JSON.stringify(sanitizedShould)}`);
  }

  // buildQuery — no keyword → match-all; a keyword → title + intro text only, never `body`
  if (buildQuery({}).bool.must.length === 0 && buildQuery({ query: '   ' }).bool.must.length === 0) {
    pass('buildQuery without a keyword → no must terms');
  } else {
    fail(`buildQuery({}) = ${JSON.stringify(buildQuery({}))}`);
  }
  const sqs = buildQuery({ query: ' confluent ' }).bool.must[0]?.simple_query_string;
  if (sqs?.query === 'confluent' && sqs.default_operator === 'and'
      && sqs.fields.includes('title^2') && sqs.fields.includes('description') && !sqs.fields.includes('body')) {
    pass('buildQuery searches title + description for the trimmed keyword, not body');
  } else {
    fail(`buildQuery keyword = ${JSON.stringify(sqs)}`);
  }

  // parseIbmResponse — happy path, location assembled from keyword_19 · keyword_17
  const sample = {
    hits: {
      hits: [
        { _source: { title: 'ML Engineer', url: 'https://ibm.com/careers/1', field_keyword_19: 'Berlin, Germany', field_keyword_17: 'Hybrid' } },
        { _source: { title: 'Data Scientist', url: 'https://ibm.com/careers/2', field_keyword_19: 'Remote' } },
      ],
    },
  };
  const jobs = parseIbmResponse(sample);
  if (jobs.length === 2 && jobs[0].company === 'IBM') pass('parseIbmResponse extracts 2 jobs with company "IBM"');
  else fail(`parseIbmResponse returned ${JSON.stringify(jobs)}`);

  if (jobs[0].location === 'Berlin, Germany · Hybrid') pass('parseIbmResponse joins location · work mode');
  else fail(`row 0 location = ${JSON.stringify(jobs[0]?.location)}`);

  if (jobs[1].location === 'Remote') pass('parseIbmResponse omits the separator when work mode is absent');
  else fail(`row 1 location = ${JSON.stringify(jobs[1]?.location)}`);

  // parseIbmResponse — company override, country appended once, Multiple Cities expanded
  const placed = parseIbmResponse({
    hits: {
      hits: [
        { _source: { title: 'A', url: 'https://ibm.com/careers/a', field_keyword_19: 'Multiple Cities', field_keyword_21: ['Toronto', 'Vancouver'], field_keyword_05: 'Canada', field_keyword_17: 'Remote' } },
        { _source: { title: 'B', url: 'https://ibm.com/careers/b', field_keyword_19: 'Berlin, Germany', field_keyword_05: 'Germany' } },
        { _source: { title: 'C', url: 'https://ibm.com/careers/c', field_keyword_19: 'Multiple Cities', field_keyword_21: ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9'], field_keyword_05: 'United States' } },
        { _source: { title: 'D', url: 'https://ibm.com/careers/d', field_keyword_05: 'India', field_keyword_17: 'Hybrid' } },
      ],
    },
  }, 'Confluent');
  if (placed.every(j => j.company === 'Confluent')) pass('parseIbmResponse stamps the company it is given');
  else fail(`parseIbmResponse company = ${JSON.stringify(placed.map(j => j.company))}`);
  if (placed[0]?.location === 'Multiple Cities (Toronto; Vancouver), Canada · Remote') pass('parseIbmResponse names the cities and country of a Multiple Cities posting');
  else fail(`Multiple Cities location = ${JSON.stringify(placed[0]?.location)}`);
  if (placed[1]?.location === 'Berlin, Germany') pass('parseIbmResponse does not repeat a country the location already names');
  else fail(`repeated-country location = ${JSON.stringify(placed[1]?.location)}`);
  if (placed[2]?.location === 'Multiple Cities (c1; c2; c3; c4; c5; c6; c7; c8; …), United States') pass('parseIbmResponse caps a long city list at 8');
  else fail(`long city list = ${JSON.stringify(placed[2]?.location)}`);
  if (placed[3]?.location === 'India · Hybrid') pass('parseIbmResponse falls back to the country when no city is given');
  else fail(`country-only location = ${JSON.stringify(placed[3]?.location)}`);

  // parseIbmResponse — drops title-less, url-less, and non-http(s) entries
  const dirty = parseIbmResponse({
    hits: {
      hits: [
        { _source: { title: '', url: 'https://ibm.com/careers/3' } },
        { _source: { title: 'No URL' } },
        { _source: { title: 'Bad scheme', url: 'ftp://ibm.com/careers/4' } },
        { _source: { title: 'Good', url: 'https://ibm.com/careers/5' } },
      ],
    },
  });
  if (dirty.length === 1 && dirty[0].title === 'Good') pass('parseIbmResponse drops title-less, url-less, and non-http(s) entries');
  else fail(`parseIbmResponse dirty = ${JSON.stringify(dirty)}`);

  // parseIbmResponse — throws on unexpected shape (endpoint drift surfaces loudly)
  let drifted = false;
  try { parseIbmResponse({ results: [] }); } catch { drifted = true; }
  if (drifted) pass('parseIbmResponse throws when hits.hits[] is missing');
  else fail('parseIbmResponse should throw on unexpected API response shape');

  // fetch() — paginates until a short page, via mock ctx
  let calls = 0;
  const mockCtx = {
    fetchJson: async (url, opts) => {
      calls++;
      if (url !== 'https://www-api.ibm.com/search/api/v2') throw new Error(`unexpected url ${url}`);
      if (opts?.method !== 'POST') throw new Error('Expected POST');
      // Page 1: a full page (30 hits) → keep paging; page 2: short page → stop.
      const n = calls === 1 ? 30 : 2;
      const hits = Array.from({ length: n }, (_, i) => ({
        _source: { title: `Role ${calls}-${i}`, url: `https://ibm.com/careers/${calls}-${i}` },
      }));
      return { hits: { hits } };
    },
  };
  const fetched = await ibm.fetch({ name: 'IBM', ibm: { country: 'Germany' } }, mockCtx);
  if (calls === 2 && fetched.length === 32) pass('ibm.fetch() paginates and stops on the first short page');
  else fail(`ibm.fetch() made ${calls} calls, returned ${fetched.length} jobs`);
  if (fetched.every(j => j.company === 'IBM')) pass('ibm.fetch() defaults the company to "IBM"');
  else fail(`ibm.fetch() default company = ${JSON.stringify([...new Set(fetched.map(j => j.company))])}`);

  // fetch() — `query` reaches the request body, `company` reaches every job
  let sentBody = null;
  const keywordCtx = {
    fetchJson: async (_url, opts) => {
      sentBody = JSON.parse(opts.body);
      return { hits: { hits: [{ _source: { title: 'Director, Engineering - Confluent', url: 'https://ibm.com/careers/9' } }] } };
    },
  };
  const confluent = await ibm.fetch({ name: 'Confluent', ibm: { query: 'confluent', company: 'Confluent' } }, keywordCtx);
  if (sentBody?.query?.bool?.must?.[0]?.simple_query_string?.query === 'confluent' && sentBody.sm?.query === 'confluent'
      && sentBody._source.includes('field_keyword_21')) {
    pass('ibm.fetch() sends the keyword in query + sm and asks for the city list');
  } else {
    fail(`ibm.fetch() keyword body = ${JSON.stringify(sentBody)}`);
  }
  if (confluent.length === 1 && confluent[0].company === 'Confluent') pass('ibm.fetch() stamps ibm.company on each job');
  else fail(`ibm.fetch() keyword jobs = ${JSON.stringify(confluent)}`);

} catch (e) {
  fail(`ibm provider tests crashed: ${e.message}`);
}

