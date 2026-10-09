// Persistent board-existence memory for reverse ATS sweeps (#2840).
// Only an answer that says the board does not exist may advance a miss
// counter: a real HTTP 404, or an error its provider flagged `boardGone` (see
// boardResultStatus). Throttles, transport failures and DNS errors mean
// "unknown", never "dead".

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const DEAD_BOARD_HEADER = 'ats\tboard\tmisses\tlast_checked';
export const DEAD_BOARD_MISSES = 3;
export const DEAD_BOARD_RECHECK_DAYS = 30;

function key(ats, board) { return `${ats}\t${board}`; }

export function loadDeadBoards(file, now = Date.now()) {
  const rows = new Map();
  if (!existsSync(file)) return rows;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/).slice(1)) {
    const [ats, board, missesRaw, checked] = line.split('\t');
    const misses = Number(missesRaw);
    const lastChecked = Date.parse(checked || '');
    if (!ats || !board || !Number.isInteger(misses) || misses < 1 || !Number.isFinite(lastChecked)) continue;
    rows.set(key(ats, board), { ats, board, misses, lastChecked, now });
  }
  return rows;
}

export function boardKey(entry) {
  return String(entry?.careers_url || entry?.name || '').trim();
}

/**
 * The status to record for a board whose fetch threw.
 *
 * Some ATSes say "this board no longer exists" without a 404. Workday's CXS
 * API answers 422 for a career-site name that is gone (its public page 500s:
 * 81 of 81 such dataset boards sampled 2026-10-07), and a renamed or closed
 * iCIMS portal answers its job search with a redirect to another host or into
 * the login servlet. Only the provider can tell those answers apart from an
 * ordinary failure, so it sets `err.boardGone`; this maps the flag onto the 404
 * that recordBoardResult counts, and the same three consecutive misses retire
 * the board for the same 30 days. Anything unflagged keeps its own status.
 */
export function boardResultStatus(err) {
  return err?.boardGone === true ? 404 : err?.status;
}

export function shouldSkipDeadBoard(rows, ats, board, now = Date.now()) {
  const row = rows.get(key(ats, board));
  return Boolean(row && row.misses >= DEAD_BOARD_MISSES && now - row.lastChecked < DEAD_BOARD_RECHECK_DAYS * 86_400_000);
}

export function recordBoardResult(rows, ats, board, status, now = Date.now()) {
  const rowKey = key(ats, board);
  if (status === 200) {
    rows.delete(rowKey);
    return;
  }
  const previous = rows.get(rowKey);
  if (status !== 404) {
    if (!previous || previous.misses < DEAD_BOARD_MISSES) {
      rows.delete(rowKey);
    } else {
      rows.set(rowKey, { ...previous, lastChecked: now });
    }
    return;
  }
  const misses = Math.min(DEAD_BOARD_MISSES, (previous?.misses || 0) + 1);
  rows.set(rowKey, { ats, board, misses, lastChecked: now });
}

export function saveDeadBoards(file, rows) {
  mkdirSync(dirname(file), { recursive: true });
  const body = [...rows.values()]
    .sort((a, b) => a.ats.localeCompare(b.ats) || a.board.localeCompare(b.board))
    .map((row) => `${row.ats}\t${row.board}\t${row.misses}\t${new Date(row.lastChecked).toISOString()}`);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${DEAD_BOARD_HEADER}\n${body.length ? `${body.join('\n')}\n` : ''}`, 'utf8');
  renameSync(tmp, file);
}
