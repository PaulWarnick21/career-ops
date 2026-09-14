// tests/tracked-postings.test.mjs — "have I already dealt with this
// company+role?" (career-ops #3517-adjacent, the Sorting Desk build).
//
// The property this file exists to pin down: EVERY tracker status counts as
// "already handled," not just the positive ones. A repost of a job Paul
// already Applied to, was Rejected from, or decided to Skip must not look
// unreviewed again just because a later scan gave it a new posting URL.
import { pass, fail, ROOT } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';

console.log('\ntracked-postings — every status counts as "already handled"');

try {
  const { loadTrackedRoles, isAlreadyTracked } = await import(pathToFileURL(join(ROOT, 'tracked-postings.mjs')).href);
  const check = (label, cond) => (cond ? pass(label) : fail(label));

  const dir = mkdtempSync(join(tmpdir(), 'co-tracked-postings-'));
  const trackerPath = join(dir, 'applications.md');
  writeFileSync(trackerPath, [
    '# Applications Tracker',
    '',
    '| # | Date | Company | Via | Role | Score | Status | PDF | Report | Notes | URL |',
    '|---|------|---------|-----|------|-------|--------|-----|--------|-------|-----|',
    '| 1 | 2026-09-04 | Acme | — | Engineering Manager, Platform | 4.0/5 | Applied | ✅ | [1](../reports/001-acme-2026-09-04.md) | — | https://x.test/1 |',
    '| 2 | 2026-09-04 | Beta Corp | — | Senior Manager, Data | 2.0/5 | Rejected | ❌ | [2](../reports/002-beta-2026-09-04.md) | — | https://x.test/2 |',
    '| 3 | 2026-09-05 | Gamma Inc | — | Manager, Growth Platform | 3.0/5 | Application Skipped | ❌ | — | — | https://x.test/3 |',
    '| 4 | 2026-09-05 | Delta LLC | — | Frontend Engineer | 3.5/5 | SKIP | ❌ | — | — | https://x.test/4 |',
    '| 5 | 2026-09-06 | ? | — | Engineering Manager | 3.5/5 | Evaluated | ❌ | — | recruiter did not name client | — |',
  ].join('\n'));

  try {
    const tracked = loadTrackedRoles(trackerPath);
    check('reads a row regardless of status (Applied)', tracked.some((r) => r.role === 'Engineering Manager, Platform'));
    check('reads a Rejected row too', tracked.some((r) => r.role === 'Senior Manager, Data'));
    check('reads an Application Skipped row too', tracked.some((r) => r.role === 'Manager, Growth Platform'));
    check('reads a SKIP row too', tracked.some((r) => r.role === 'Frontend Engineer'));
    check('the "?" unknown-end-employer company is excluded (folds to no key)', tracked.length === 4);

    // ── isAlreadyTracked: company + fuzzy role ──
    check(
      'a repost with the exact same company+role is already tracked',
      isAlreadyTracked({ company: 'Acme', title: 'Engineering Manager, Platform' }, tracked),
    );
    check(
      'a repost with a reworded but equivalent role still matches',
      isAlreadyTracked({ company: 'Acme', title: 'Senior Engineering Manager, Platform' }, tracked),
    );
    check(
      'company matching is case/whitespace-insensitive (normalizeCompany)',
      isAlreadyTracked({ company: '  ACME  ', title: 'Engineering Manager, Platform' }, tracked),
    );
    check(
      'a genuinely different role at the same company is NOT already tracked',
      !isAlreadyTracked({ company: 'Acme', title: 'Backend Engineer, Payments' }, tracked),
    );
    check(
      'the same role title at a different company is NOT already tracked',
      !isAlreadyTracked({ company: 'Zeta Co', title: 'Engineering Manager, Platform' }, tracked),
    );
    check(
      'a Rejected-status repost still counts as already tracked (not just positive outcomes)',
      isAlreadyTracked({ company: 'Beta Corp', title: 'Senior Manager, Data' }, tracked),
    );
    check(
      'an Application-Skipped-status repost still counts as already tracked',
      isAlreadyTracked({ company: 'Gamma Inc', title: 'Manager, Growth Platform' }, tracked),
    );
    check(
      'a plain SKIP-status repost still counts as already tracked',
      isAlreadyTracked({ company: 'Delta LLC', title: 'Frontend Engineer' }, tracked),
    );
    check('an empty tracker path yields no tracked roles, not a crash', loadTrackedRoles(join(dir, 'missing.md')).length === 0);
    check('a candidate with no company never matches (never claims a false positive)', !isAlreadyTracked({ company: '', title: 'Anything' }, tracked));
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
} catch (err) {
  fail(`tracked-postings test suite threw: ${err?.message ?? err}`);
}
