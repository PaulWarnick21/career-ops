// tests/liveness-api-workday-apply.test.mjs — a Workday posting link that ends
// in its apply step (`/apply`, `/apply/applyManually`) is the same posting.
// Left in the derived job path, the per-job CXS endpoint answers 404 for a live
// posting, which checkLivenessViaApi reports as "posting removed" and every JD
// reader built on resolveAtsApi (browser-extract.mjs workdayCxsUrl, rank-deep,
// jd-resolver) reads as unreadable. Seen 2026-10-08 on KLA _2639643-1: 404 with
// /apply, 200 without.
import { pass, fail, ROOT } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nliveness-api Workday — a trailing apply step is not part of the job id');

const check = (label, cond) => (cond ? pass(label) : fail(label));

try {
  const { resolveAtsApi } = await import(pathToFileURL(join(ROOT, 'liveness-api.mjs')).href);
  const base = 'https://kla.wd1.myworkdayjobs.com/en-US/Search/job/Software-Engineering-Manager---Remote-Services_2639643-1';
  const want = 'https://kla.wd1.myworkdayjobs.com/wday/cxs/kla/Search/job/Software-Engineering-Manager---Remote-Services_2639643-1';
  const api = (u) => resolveAtsApi(u)?.apiUrl;

  check('plain posting link → its CXS job URL', api(base) === want);
  check('…/apply → the same CXS job URL', api(`${base}/apply`) === want);
  check('…/apply/ (trailing slash) → the same CXS job URL', api(`${base}/apply/`) === want);
  check('…/apply/applyManually → the same CXS job URL', api(`${base}/apply/applyManually`) === want);
  check('…/apply?source=x (query) → the same CXS job URL', api(`${base}/apply?source=x`) === want);
  check('a location + title path keeps both segments when /apply is dropped',
    api('https://autodesk.wd1.myworkdayjobs.com/en-US/Ext/job/Toronto-ON-CAN/Software-Development-Manager_25WD94143/apply')
      === 'https://autodesk.wd1.myworkdayjobs.com/wday/cxs/autodesk/Ext/job/Toronto-ON-CAN/Software-Development-Manager_25WD94143');
  check('a title slug that merely contains "apply" is untouched',
    api('https://acme.wd5.myworkdayjobs.com/careers/job/Remote/Applied-Science-Manager_R100') === 'https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/careers/job/Remote/Applied-Science-Manager_R100');
  check('a board page with no /job/ is still not a posting', resolveAtsApi('https://kla.wd1.myworkdayjobs.com/en-US/Search') === null);
  check('path traversal is still refused', resolveAtsApi('https://kla.wd1.myworkdayjobs.com/Search/job/../x_1/apply') === null);
} catch (err) {
  fail(`liveness-api Workday apply suite threw: ${err?.message ?? err}`);
}
