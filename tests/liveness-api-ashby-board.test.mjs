import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pass, fail, ROOT } from './helpers.mjs';

// 2026-10-06: Hiive renamed its Ashby board to `claritymovescapital`. The old
// board 404s as a whole while the same job id stays live on the new one, and
// the 404 was read as "posting removed" — a live application marked closed.
test('liveness-api: a missing Ashby BOARD is uncertain, a job missing from a live board is expired', async () => {
  const { checkLivenessViaApi } = await import(pathToFileURL(join(ROOT, 'liveness-api.mjs')).href);
  const realFetch = globalThis.fetch;
  const respond = (status, body) => async () => ({ status, json: async () => body });
  try {
    globalThis.fetch = respond(404, null);
    const gone = await checkLivenessViaApi('https://jobs.ashbyhq.com/oldname/46f2ef56-2d33-4b47-8ef1-c3e13429f3c4');
    globalThis.fetch = respond(200, { jobs: [{ id: 'other-job', isListed: true }] });
    const unlisted = await checkLivenessViaApi('https://jobs.ashbyhq.com/newname/46f2ef56-2d33-4b47-8ef1-c3e13429f3c4');
    globalThis.fetch = respond(200, { jobs: [{ id: '46f2ef56-2d33-4b47-8ef1-c3e13429f3c4', isListed: true }] });
    const live = await checkLivenessViaApi('https://jobs.ashbyhq.com/newname/46f2ef56-2d33-4b47-8ef1-c3e13429f3c4');
    const ok = gone?.result === 'uncertain' && gone.code === 'ashby_board_missing'
      && unlisted?.result === 'expired' && live?.result === 'active';
    if (ok) pass('liveness-api: Ashby board 404 no longer reads as a closed posting');
    else { fail(`wrong verdicts: ${JSON.stringify({ gone, unlisted, live })}`); assert.fail('ashby board-404 verdict wrong'); }
  } finally {
    globalThis.fetch = realFetch;
  }
});
