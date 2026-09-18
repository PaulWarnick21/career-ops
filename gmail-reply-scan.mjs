#!/usr/bin/env node

/**
 * gmail-reply-scan.mjs — automatic Gmail scan for employer replies (#1583).
 *
 * paste-reply.mjs's header has said since #1802 that "the only planned way to
 * populate [data/reply-candidates.json] is a Gmail scanner (#1583, unbuilt,
 * requires OAuth inbox-read access)" — this is that scanner. It is the
 * counterpart to the bundled `gmail` plugin (plugins/gmail/), which pulls job
 * LEADS into data/pipeline.md; this script pulls REPLIES into
 * data/reply-candidates.json instead, so it lives outside the plugin engine
 * (an `ingest` hook's Job[] return is written to pipeline.md canonically —
 * the wrong destination for a reply) the same way paste-reply.mjs does.
 *
 * WHAT IT DOES NOT DO: classify anything, or touch data/applications.md.
 * That split is deliberate (see AGENTS.md "Untrusted External Content" and
 * "Source-of-Truth Boundary" — an employer email is untrusted content that
 * can influence classification but never write the tracker on its own).
 * This script's only job is ingestion: read recent mail, keep only messages
 * that plausibly relate to an application already being tracked, and append
 * them — verbatim, unclassified — to data/reply-candidates.json in the exact
 * shape reply-watch.mjs expects. Classification and the human confirmation
 * gate stay reply-watch.mjs's job (run it directly, or open the Application
 * Tracker, which surfaces the same suggestions with a one-tap confirm/dismiss
 * — see modes/application-tracker-sync.md).
 *
 * RELEVANCE FILTER: a message is kept only when reply-matcher.mjs's
 * matchCandidates() ties it to a tracker row currently in an ACTIVE status
 * (Applied/Responded/Interview/Offer — see ACTIVE_STATUSES). This keeps
 * unrelated inbox mail (newsletters, personal email, unrelated work) out of
 * reply-candidates.json entirely, rather than relying on reply-watch.mjs to
 * discard it later. The match itself is re-derived by reply-watch.mjs when it
 * runs (this script does not persist match metadata — only the raw candidate
 * shape), so a later tracker edit can never make a stored match stale.
 *
 * OPT-IN, off by default: enable in config/plugins.yml under a
 * `gmail-reply-scan` block (see config/plugins.example.yml). Read directly by
 * this script — NOT through plugins.mjs/the engine, since this isn't a
 * manifest-declared plugin. Shares the SAME GMAIL_CLIENT_ID/GMAIL_CLIENT_SECRET/
 * GMAIL_REFRESH_TOKEN as the `gmail` plugin (one read-only OAuth client) —
 * no new .env keys needed.
 *
 * Safe to run repeatedly / on a schedule: a per-message-id processed cursor
 * (data/gmail-reply-scan-state.json, this script's own file — separate from
 * the `gmail` plugin's data/gmail-state.json) means a message already looked
 * at is never re-fetched.
 *
 * Usage:
 *   node gmail-reply-scan.mjs [--dry-run] [--limit N]
 *   node gmail-reply-scan.mjs --help
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';
import { getAccessToken, isAuthenticEmail, getMessageBody } from './plugins/gmail/_helpers.mjs';
import { loadDotenvOnce } from './plugins/_engine.mjs';
import { resolveColumns, parseTrackerRow } from './tracker-parse.mjs';
import { resolveTrackerPath, getCareerOpsRoot } from './path-resolver.mjs';
import { matchCandidates } from './reply-matcher.mjs';
import { appendCandidate } from './paste-reply.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
// This script's own processed-id cursor — a USER-layer file (data/), so it
// must resolve through getCareerOpsRoot() (Data Contract root override), not
// the codebase root. Computed as a default-parameter expression below (not a
// module-level const) so each call re-resolves it, honoring CAREER_OPS_ROOT/
// CAREER_OPS_DATA_DIR even if set only after this module was imported.
const defaultStatePath = () => join(getCareerOpsRoot(), 'data', 'gmail-reply-scan-state.json');
const PLUGINS_CONFIG_PATH = join(HERE, 'config', 'plugins.yml'); // system-layer config, not user data — codebase root is correct here
const DEFAULT_DAYS_BACK = 14;
const DEFAULT_LIMIT = 300; // cap on messages listed per run, so a huge mailbox can't run away
const BODY_SNIPPET_CAP = 4000; // chars — reply-matcher.mjs only needs enough text to match/classify

// Statuses a reply can still plausibly land against. Terminal states
// (Rejected/Discarded/Hired/SKIP/Application Skipped) are excluded — there is
// no tracker transition left for a reply about one of those to suggest.
const ACTIVE_STATUSES = new Set(['applied', 'responded', 'interview', 'offer']);

function loadPluginSettings(configPath = PLUGINS_CONFIG_PATH) {
  if (!existsSync(configPath)) return { enabled: false, daysBack: DEFAULT_DAYS_BACK };
  try {
    const doc = yaml.load(readFileSync(configPath, 'utf8')) || {};
    const block = doc?.plugins?.['gmail-reply-scan'] || {};
    const daysBack = Number(block.days_back);
    return {
      enabled: block.enabled === true,
      daysBack: Number.isFinite(daysBack) && daysBack > 0 ? daysBack : DEFAULT_DAYS_BACK,
    };
  } catch (err) {
    console.warn(`gmail-reply-scan: could not parse config/plugins.yml (${err.message}) — treating as disabled`);
    return { enabled: false, daysBack: DEFAULT_DAYS_BACK };
  }
}

/** Tracker rows in an active (non-terminal) status — the only ones a reply can update. */
export function loadActiveApps(trackerPath) {
  if (!existsSync(trackerPath)) return [];
  const lines = readFileSync(trackerPath, 'utf8').split('\n');
  const colmap = resolveColumns(lines);
  const apps = [];
  for (const line of lines) {
    const row = parseTrackerRow(line, colmap);
    if (!row) continue;
    if (!ACTIVE_STATUSES.has((row.status || '').trim().toLowerCase())) continue;
    apps.push(row);
  }
  return apps;
}

/** Same shape reply-watch.mjs reads from data/follow-ups.md — used only to
 *  corroborate a sender domain against an application (getAppDomains). */
export function loadFollowups(root) {
  const followupsPath = join(root, 'data', 'follow-ups.md');
  if (!existsSync(followupsPath)) return [];
  const lines = readFileSync(followupsPath, 'utf8').split('\n');
  const followups = [];
  for (const line of lines) {
    if (!line.startsWith('|')) continue;
    const parts = line.split('|').map((s) => s.trim());
    if (parts.length < 8) continue;
    const num = parseInt(parts[1], 10);
    const appNum = parseInt(parts[2], 10);
    if (Number.isNaN(num) || Number.isNaN(appNum)) continue;
    followups.push({
      num, appNum, date: parts[3], company: parts[4], role: parts[5],
      channel: parts[6], contact: parts[7], notes: parts[8] || '',
    });
  }
  return followups;
}

function loadProcessedIds(statePath = defaultStatePath()) {
  if (!existsSync(statePath)) return new Set();
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf-8'));
    return new Set(state.processed_message_ids || []);
  } catch {
    return new Set();
  }
}

function saveProcessedIds(ids, statePath = defaultStatePath()) {
  try {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify({ processed_message_ids: [...ids] }, null, 2), 'utf-8');
  } catch (err) {
    console.warn(`gmail-reply-scan: could not persist processed-id state — ${err.message}`);
  }
}

function headerValue(headers, name) {
  return headers.find((h) => h.name?.toLowerCase() === name)?.value || '';
}

/**
 * Scan Gmail and append relevant reply candidates. Returns a summary object;
 * never throws for an individual message (a bad detail fetch is skipped, not
 * fatal — same resilience posture as the `gmail` plugin).
 */
export async function scan({
  clientId, clientSecret, refreshToken, apps, followups = [], daysBack = DEFAULT_DAYS_BACK,
  limit = DEFAULT_LIMIT, dryRun = false, fetchFn = globalThis.fetch,
  candidatesPath, statePath = defaultStatePath(), log = console.log,
} = {}) {
  if (!apps.length) return { added: 0, scanned: 0, skippedNoMatch: 0, skippedUnauthenticated: 0, reason: 'no-active-applications' };

  const token = await getAccessToken({ clientId, clientSecret, refreshToken }, fetchFn);
  const auth = { Authorization: `Bearer ${token}` };
  const query = `newer_than:${daysBack}d`;
  log(`gmail-reply-scan: querying ${query}`);

  const messages = [];
  let pageToken = null;
  do {
    let url = `${GMAIL_API}/messages?q=${encodeURIComponent(query)}&maxResults=100`;
    if (pageToken) url += `&pageToken=${pageToken}`;
    const data = await (await fetchFn(url, { headers: auth })).json();
    if (data.messages) messages.push(...data.messages);
    pageToken = messages.length < limit ? data.nextPageToken : null;
  } while (pageToken);

  const capped = messages.slice(0, limit);
  const processedIds = loadProcessedIds(statePath);
  let added = 0;
  let skippedNoMatch = 0;
  let skippedUnauthenticated = 0;

  for (const m of capped) {
    if (processedIds.has(m.id)) continue;
    processedIds.add(m.id); // mark seen regardless of outcome — never re-fetch the same message twice

    let msg;
    try {
      msg = await (await fetchFn(`${GMAIL_API}/messages/${m.id}?format=full`, { headers: auth })).json();
    } catch (err) {
      console.warn(`gmail-reply-scan: failed to fetch message ${m.id} — ${err.message}`);
      continue;
    }

    const headers = msg.payload?.headers || [];
    const subject = headerValue(headers, 'subject');
    if (!isAuthenticEmail(headers)) {
      skippedUnauthenticated += 1;
      continue;
    }

    const from = headerValue(headers, 'from');
    const body = getMessageBody(msg.payload).slice(0, BODY_SNIPPET_CAP);
    const candidate = { message_id: `gmail-${m.id}`, from, subject, body_snippet: body, signal: null };

    const [match] = matchCandidates([candidate], apps, followups);
    if (match?.application_num == null) {
      skippedNoMatch += 1;
      continue;
    }

    if (!dryRun) appendCandidate(candidate, candidatesPath);
    added += 1;
  }

  if (!dryRun) saveProcessedIds(processedIds, statePath);
  return { added, scanned: capped.length, skippedNoMatch, skippedUnauthenticated };
}

// ── CLI ──────────────────────────────────────────────────────────────────
function printHelp() {
  const doc = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  console.log(doc.slice(doc.indexOf('/**') + 3, doc.indexOf('*/')).replace(/^ \* ?/gm, '').trim());
}

async function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) { printHelp(); return 0; }
  const dryRun = argv.includes('--dry-run');
  const limitIdx = argv.indexOf('--limit');
  const limit = limitIdx >= 0 ? Math.max(1, Number(argv[limitIdx + 1]) || DEFAULT_LIMIT) : DEFAULT_LIMIT;

  await loadDotenvOnce();

  const settings = loadPluginSettings();
  if (!settings.enabled) {
    console.log('gmail-reply-scan: disabled. Enable it in config/plugins.yml under `gmail-reply-scan: { enabled: true }` (see config/plugins.example.yml).');
    return 0;
  }

  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    console.error('gmail-reply-scan: missing GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN in .env');
    return 1;
  }

  const root = getCareerOpsRoot();
  const trackerPath = resolveTrackerPath(root);
  const apps = loadActiveApps(trackerPath);
  if (!apps.length) {
    console.log('gmail-reply-scan: no applications in an active status (Applied/Responded/Interview/Offer) — nothing to watch for replies.');
    return 0;
  }
  const followups = loadFollowups(root);

  const result = await scan({
    clientId, clientSecret, refreshToken, apps, followups,
    daysBack: settings.daysBack, limit, dryRun,
  });

  console.log(
    `gmail-reply-scan: scanned ${result.scanned} message(s) — ${result.added} new candidate(s) added` +
    (result.skippedNoMatch ? `, ${result.skippedNoMatch} not tied to a tracked application` : '') +
    (result.skippedUnauthenticated ? `, ${result.skippedUnauthenticated} skipped (unauthenticated sender)` : '') +
    (dryRun ? ' [dry run — nothing written]' : '') + '.',
  );
  if (result.added > 0 && !dryRun) {
    console.log('Run `node reply-watch.mjs` to classify and review, or open the Application Tracker.');
  }
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)));
}
