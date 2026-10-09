import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pass, fail } from './helpers.mjs';
import { boardKey, boardResultStatus, loadDeadBoards, recordBoardResult, saveDeadBoards, shouldSkipDeadBoard } from '../dead-boards.mjs';

console.log('\nPersistent dead-board memory (#2840)');
const root = mkdtempSync(join(tmpdir(), 'career-ops-dead-boards-'));
const file = join(root, 'data', 'dead-boards.tsv');
const now = Date.parse('2026-08-14T00:00:00Z');
try {
  const rows = loadDeadBoards(file, now);
  const board = boardKey({ careers_url: 'https://jobs.example.test/acme' });
  recordBoardResult(rows, 'lever', board, 500, now);
  recordBoardResult(rows, 'lever', board, 404, now);
  recordBoardResult(rows, 'lever', board, 404, now);
  if (!shouldSkipDeadBoard(rows, 'lever', board, now)) pass('fewer than three 404s never retires a board');
  else fail('a board was retired before three consecutive 404s');
  recordBoardResult(rows, 'lever', board, 404, now);
  if (shouldSkipDeadBoard(rows, 'lever', board, now)) pass('three 404s retire a board for the re-probe window');
  else fail('three 404s did not retire a board');
  recordBoardResult(rows, 'lever', board, 429, now);
  if (shouldSkipDeadBoard(rows, 'lever', board, now)) pass('429 does not create or clear a dead-board record');
  else fail('429 incorrectly changed dead-board state');
  const cleanBoard = 'https://jobs.example.test/clean';
  recordBoardResult(rows, 'lever', cleanBoard, 429, now);
  if (!rows.has(`lever\t${cleanBoard}`)) pass('429 does not create a dead-board record');
  else fail('429 incorrectly created a dead-board record');
  recordBoardResult(rows, 'lever', board, 200, now);
  if (!shouldSkipDeadBoard(rows, 'lever', board, now)) pass('a successful response clears a retired board');
  else fail('a successful response left a board retired');
  recordBoardResult(rows, 'lever', board, 404, now);
  recordBoardResult(rows, 'lever', board, 404, now);
  recordBoardResult(rows, 'lever', board, 404, now);
  saveDeadBoards(file, rows);
  const serialized = readFileSync(file, 'utf8');
  if (/^ats\tboard\tmisses\tlast_checked\nlever\thttps:\/\/jobs\.example\.test\/acme\t3\t2026-08-14T00:00:00\.000Z\n$/.test(serialized)) pass('dead-board store persists the safe TSV contract');
  else fail('dead-board store wrote an invalid TSV contract');
  const reloaded = loadDeadBoards(file, now);
  if (shouldSkipDeadBoard(reloaded, 'lever', board, now)) pass('saved dead-board state reloads into the same skip decision');
  else fail('saved dead-board state did not reload correctly');
  const malformedFile = join(root, 'data', 'malformed.tsv');
  writeFileSync(malformedFile, `${serialized}lever\tbad\tNaN\tnot-a-date\n`, 'utf8');
  if (loadDeadBoards(malformedFile, now).size === 1) pass('malformed dead-board rows are ignored on reload');
  else fail('malformed dead-board rows were not ignored on reload');
  if (shouldSkipDeadBoard(reloaded, 'lever', board, now + 29 * 86_400_000) && !shouldSkipDeadBoard(reloaded, 'lever', board, now + 30 * 86_400_000)) pass('retired boards re-probe at the 30-day boundary');
  else fail('retired board re-probe window has the wrong boundary');
  const failedProbeAt = now + 30 * 86_400_000;
  recordBoardResult(reloaded, 'lever', board, 429, failedProbeAt);
  if (reloaded.get(`lever\t${board}`)?.lastChecked === failedProbeAt && shouldSkipDeadBoard(reloaded, 'lever', board, failedProbeAt + 1)) pass('a failed retired-board probe refreshes its re-probe timestamp');
  else fail('a failed retired-board probe did not refresh its re-probe timestamp');
  const partial = new Map();
  recordBoardResult(partial, 'lever', board, 404, now);
  recordBoardResult(partial, 'lever', board, 500, now);
  if (!partial.has(`lever\t${board}`)) pass('transient errors clear partial 404 progress');
  else fail('transient errors kept partial 404 progress');

  // A provider that recognises a "board is gone" answer other than a 404
  // (Workday's 422, a renamed or closed iCIMS portal's redirect) flags the
  // error; boardResultStatus turns the flag into the miss a 404 counts as.
  const gone = Object.assign(new Error('HTTP 422 Unprocessable Entity'), { status: 422, boardGone: true });
  const unflagged = Object.assign(new Error('HTTP 422 Unprocessable Entity'), { status: 422 });
  if (boardResultStatus(gone) === 404) pass('a boardGone error records as a miss (404)');
  else fail(`boardGone error recorded as ${boardResultStatus(gone)}`);
  if (boardResultStatus(unflagged) === 422 && boardResultStatus(Object.assign(new Error('x'), { status: 503 })) === 503) pass('an unflagged error keeps its own status');
  else fail('an unflagged error lost its status');
  if (boardResultStatus(new TypeError('fetch failed')) === undefined && boardResultStatus(null) === undefined && boardResultStatus(undefined) === undefined) pass('a status-less error or no error records no status');
  else fail('a status-less error was given a status');
  if (boardResultStatus(Object.assign(new Error('x'), { status: 422, boardGone: 'yes' })) === 422) pass('only boardGone === true counts as gone');
  else fail('a truthy non-true boardGone was counted as gone');
  const workdayRows = new Map();
  const workdayBoard = 'https://acme.wd1.myworkdayjobs.com/old_site';
  for (let i = 0; i < 3; i++) recordBoardResult(workdayRows, 'workday', workdayBoard, boardResultStatus(gone), now);
  if (shouldSkipDeadBoard(workdayRows, 'workday', workdayBoard, now)) pass('three boardGone misses retire a board like three 404s');
  else fail('three boardGone misses did not retire the board');
  const unflaggedRows = new Map();
  for (let i = 0; i < 3; i++) recordBoardResult(unflaggedRows, 'workday', workdayBoard, boardResultStatus(unflagged), now);
  if (!unflaggedRows.size) pass('an unflagged 422 never creates a dead-board record');
  else fail('an unflagged 422 created a dead-board record');
} finally {
  rmSync(root, { recursive: true, force: true });
}
