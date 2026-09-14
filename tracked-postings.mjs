/**
 * tracked-postings.mjs — "have I already dealt with this company+role?"
 *
 * Shared by notify-digest.mjs (don't re-email it) and sorting-desk-build.mjs
 * (don't show it in #1 Unreviewed again) so a REPOST — the same underlying
 * job re-scanned under a new posting URL — doesn't look brand new just
 * because scan-history.tsv's URL-based dedup can't recognize it.
 *
 * data/scan-history.tsv already stops the exact same URL from re-entering
 * data/pipeline.md; this covers the gap that leaves open — a new URL for a
 * job Paul already Applied to, was Rejected from, or decided to Skip. Every
 * status counts, on purpose (2026-09-13, Paul's call): a job that's Rejected
 * or Application Skipped is exactly as "already handled" as one that's
 * Applied — none of them should come back looking unreviewed.
 *
 * Matching is company (normalizeCompany — same key merge-tracker.mjs's own
 * dedup uses) + fuzzy role title (role-matcher.mjs's roleFuzzyMatch, so
 * "Engineering Manager, Platform" still matches "EM, Platform Team" from a
 * later repost). Scoped to company first, then fuzzy-matched only within
 * that company's rows — cheap even at a few hundred tracker rows.
 */

import { readFileSync, existsSync } from 'node:fs';
import { normalizeCompany } from './tracker-utils.mjs';
import { roleFuzzyMatch } from './role-matcher.mjs';

function splitRow(line) {
  return line.split('|').map((s) => s.trim());
}

/**
 * Every {companyKey, role} pair the tracker already has a row for, regardless
 * of status — Applied, Rejected, Application Skipped, Interested, whatever.
 * @param {string} trackerPath
 * @returns {{companyKey: string, role: string}[]}
 */
export function loadTrackedRoles(trackerPath) {
  if (!existsSync(trackerPath)) return [];
  const lines = readFileSync(trackerPath, 'utf8').replace(/\r/g, '').split('\n');
  const headerLine = lines.find((l) => l.trim().startsWith('|') && /\bstatus\b/i.test(l) && /\bcompany\b/i.test(l));
  if (!headerLine) return [];
  const headers = splitRow(headerLine).map((h) => h.toLowerCase());
  const iCompany = headers.indexOf('company');
  const iRole = headers.indexOf('role');
  if (iCompany < 0 || iRole < 0) return [];

  const out = [];
  for (const line of lines) {
    if (!line.trim().startsWith('|') || line === headerLine) continue;
    const cells = splitRow(line);
    if (cells.length <= Math.max(iCompany, iRole)) continue;
    const company = (cells[iCompany] || '').replace(/\*\*/g, '').trim();
    const role = (cells[iRole] || '').replace(/\*\*/g, '').trim();
    if (!company || company === '#' || /^-+$/.test(company)) continue; // header/separator guard
    const companyKey = normalizeCompany(company);
    if (!companyKey) continue; // '?' (unknown end employer) folds to '' — never a match target
    out.push({ companyKey, role });
  }
  return out;
}

/**
 * True when `candidate` (a company+title pair from a freshly scanned/ranked
 * posting) already has a tracker row for the same company and a fuzzy-
 * matching role. `tracked` is the array loadTrackedRoles() returns — load it
 * once per run and reuse across every candidate, not once per candidate.
 */
export function isAlreadyTracked(candidate, tracked) {
  const companyKey = normalizeCompany(candidate.company);
  if (!companyKey) return false;
  for (const row of tracked) {
    if (row.companyKey !== companyKey) continue;
    if (roleFuzzyMatch(candidate.title, row.role)) return true;
  }
  return false;
}
