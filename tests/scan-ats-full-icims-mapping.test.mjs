// tests/scan-ats-full-icims-mapping.test.mjs — how the reverse sweep turns an
// iCIMS dataset row into board URLs.
//
// The dataset (Feashliaa/job-board-aggregator icims_companies.json) mixes bare
// tenant ids ("48forty") with full portal subdomains ("careers-48forty",
// "us-careers-verathon"). The old mapper prepended careers- to every row, so a
// full subdomain became careers-careers-48forty.icims.com, which returns 404,
// and no portal the dataset names in full was ever scanned. Each case below is
// shaped like a real dataset row whose live behaviour was checked 2026-09-24.
import { join } from 'path';
import { pathToFileURL } from 'url';
import { pass, fail, ROOT } from './helpers.mjs';

console.log('\nscan-ats-full — iCIMS dataset row → board URL mapping');

const { SOURCES, icimsHosts, uniqueEntries } = await import(pathToFileURL(join(ROOT, 'scan-ats-full.mjs')).href);
const toEntry = SOURCES.icims.toEntry;
const url = (host) => `https://${host}.icims.com/jobs/search?ss=1&in_iframe=1`;
const urlsOf = (row) => toEntry(row).map(e => e.careers_url);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function expectUrls(row, hosts, why) {
  const got = urlsOf(row);
  const want = hosts.map(url);
  if (same(got, want)) pass(`${row} → ${hosts.join(' + ')} (${why})`);
  else fail(`${row}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}

// ── bare tenant ids: the default careers- portal is prepended ──────────
// 48forty.icims.com redirects instead of serving a board, so the prefix is
// still required for one-word rows.
expectUrls('48forty', ['careers-48forty'], 'one-word row is a bare tenant id');
expectUrls('capreitcareers', ['careers-capreitcareers'], 'a career token inside one word is still a tenant id');

// ── full portal subdomains: used as-is, never prefixed again ───────────
expectUrls('careers-48forty', ['careers-48forty'], 'default portal already named in full');
expectUrls('us-careers-verathon', ['us-careers-verathon'], 'regional portal');
expectUrls('ca-careers-torys', ['ca-careers-torys'], 'regional portal');
expectUrls('career-celanese', ['career-celanese'], 'singular career token');
expectUrls('saspro-uscareers', ['saspro-uscareers'], 'career token at the end');
{
  const built = [
    'careers-48forty', 'us-careers-verathon', 'ca-careers-torys', 'career-celanese',
  ].flatMap(urlsOf);
  if (built.some(u => u.includes('careers-careers-') || /\/\/careers-[a-z]+-careers-/.test(u))) {
    fail(`a full subdomain was prefixed again: ${JSON.stringify(built)}`);
  } else {
    pass('no full subdomain is ever prefixed with a second careers-');
  }
}

// ── ambiguous hyphenated rows: both candidates ─────────────────────────
// "team-thefreshmarket" serves at team-thefreshmarket.icims.com, but
// "fr-moncler" serves at careers-fr-moncler.icims.com, and nothing in the text
// tells the two apart. Both hosts are built; dead-board memory retires the
// one that keeps returning 404.
expectUrls('team-thefreshmarket', ['team-thefreshmarket', 'careers-team-thefreshmarket'], 'portal or tenant — both tried');
expectUrls('fr-moncler', ['fr-moncler', 'careers-fr-moncler'], 'portal or tenant — both tried');

// ── entry names: a board keeps the company name it had before ──────────
{
  const bare = toEntry('48forty');
  const full = toEntry('careers-48forty');
  if (bare.length === 1 && full.length === 1 && bare[0].name === '48forty' && full[0].name === '48forty') {
    pass('"48forty" and "careers-48forty" both name their board "48forty"');
  } else {
    fail(`default-portal names differ: ${JSON.stringify({ bare, full })}`);
  }
  const regional = toEntry('us-careers-verathon');
  if (regional[0]?.name === 'us-careers-verathon') pass('a non-default portal is named by its subdomain');
  else fail(`regional portal name: ${JSON.stringify(regional)}`);
}

// ── normalisation and rejection ────────────────────────────────────────
expectUrls('ACME', ['careers-acme'], 'host is lowercased');
for (const [row, why] of [
  ['-careers-harrowcouncil', 'leading hyphen (a real dataset row) is not a DNS label'],
  ['acme-', 'trailing hyphen is not a DNS label'],
  ['acme.evil.com', 'a dot would add labels under .icims.com'],
  ['evil/..%2f', 'outside the slug charset'],
  ['under_score', 'underscore is not valid in a hostname'],
  ['', 'empty row'],
  ['Kcme', 'non-ASCII that lowercases to ASCII (Kelvin sign)'],
  ['a'.repeat(64), 'longer than one DNS label'],
]) {
  const got = toEntry(row);
  if (Array.isArray(got) && got.length === 0) pass(`rejects ${JSON.stringify(row.length > 20 ? `${row.slice(0, 8)}…(${row.length})` : row)} — ${why}`);
  else fail(`accepted ${JSON.stringify(row)} (${why}): ${JSON.stringify(got)}`);
}
{
  // A 63-char one-word row is a valid label on its own, but careers- pushes it
  // past 63, so it has no host to build.
  const label = 'b'.repeat(63);
  if (icimsHosts(label).length === 0) pass('drops a bare id whose careers- host would exceed one DNS label');
  else fail(`built an over-long host: ${JSON.stringify(icimsHosts(label))}`);
}

// ── host-equality guard still holds for every built URL ────────────────
{
  const rows = ['48forty', 'careers-48forty', 'us-careers-verathon', 'fr-moncler', 'ACME'];
  const bad = rows.flatMap(toEntry).filter(e => {
    const host = new URL(e.careers_url).hostname;
    return !host.endsWith('.icims.com') || host.split('.').length !== 3;
  });
  if (bad.length === 0) pass('every built URL is a single label directly under .icims.com');
  else fail(`URLs off the iCIMS host shape: ${JSON.stringify(bad)}`);
}

// ── dedup: a tenant listed both ways is fetched once ───────────────────
{
  const rows = ['48forty', 'careers-48forty', 'fr-moncler', 'careers-fr-moncler', 'verathon', 'us-careers-verathon'];
  const entries = uniqueEntries(rows.flatMap(toEntry));
  const got = entries.map(e => e.careers_url);
  const want = [
    'careers-48forty', 'fr-moncler', 'careers-fr-moncler', 'careers-verathon', 'us-careers-verathon',
  ].map(url);
  if (same(got, want)) pass('uniqueEntries collapses rows that name the same board, keeping first-seen order');
  else fail(`uniqueEntries: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);

  const again = uniqueEntries(rows.flatMap(toEntry)).map(e => e.careers_url);
  if (same(again, got)) pass('uniqueEntries is deterministic (resume offsets depend on it)');
  else fail('uniqueEntries produced a different order on the same input');
}
