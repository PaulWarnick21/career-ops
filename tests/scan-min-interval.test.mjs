// tests/scan-min-interval.test.mjs — per-entry `min_interval_minutes` in
// portals.yml: an entry is fetched at most once every N minutes, measured from
// its newest data/portal-health.tsv row. Added for Jobicy, whose API asks
// integrations not to poll more often than hourly while auto-scan runs
// scan.mjs every 30 minutes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { lastFetchTimes, minIntervalGate } from '../scan.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCAN = join(ROOT, 'scan.mjs');
const MIN = 60_000;

test('lastFetchTimes keeps the newest timestamp per name and skips unreadable rows', () => {
  const last = lastFetchTimes([
    { timestamp: '2026-09-25T10:00:00.000Z', company: 'Jobicy', status: 'reachable' },
    { timestamp: '2026-09-25T11:00:00.000Z', company: 'Jobicy', status: 'server' },
    { timestamp: '2026-09-25T09:00:00.000Z', company: 'Jobicy', status: 'reachable' },
    { timestamp: 'not-a-date', company: 'Acme', status: 'reachable' },
    { timestamp: '2026-09-25T12:00:00.000Z', company: '', status: 'reachable' },
  ]);
  assert.equal(last.get('Jobicy'), Date.parse('2026-09-25T11:00:00.000Z'), 'a failed attempt counts: it still reached the source');
  assert.equal(last.has('Acme'), false);
  assert.equal(last.size, 1);
});

test('minIntervalGate: no setting or no recorded fetch -> fetch now', () => {
  const now = Date.parse('2026-09-25T12:00:00.000Z');
  const last = new Map([['Jobicy', now - 5 * MIN]]);
  assert.deepEqual(minIntervalGate({ name: 'Jobicy' }, last, now), { waitMs: 0 });
  assert.deepEqual(minIntervalGate({ name: 'Jobicy', min_interval_minutes: null }, last, now), { waitMs: 0 });
  assert.deepEqual(minIntervalGate({ name: 'Never Fetched', min_interval_minutes: 60 }, last, now), { waitMs: 0, minutes: 60 });
});

test('minIntervalGate waits out the rest of the interval, and not a moment longer', () => {
  const now = Date.parse('2026-09-25T12:00:00.000Z');
  const gate = (agoMin, minutes = 60) => minIntervalGate(
    { name: 'Jobicy', min_interval_minutes: minutes },
    new Map([['Jobicy', now - agoMin * MIN]]),
    now,
  );
  assert.equal(gate(10).waitMs, 50 * MIN);
  assert.equal(gate(10).lastMs, now - 10 * MIN);
  assert.equal(gate(59.5).waitMs, 0.5 * MIN);
  assert.equal(gate(60).waitMs, 0, 'exactly N minutes later is due');
  assert.equal(gate(61).waitMs, 0);
  assert.equal(gate(10, 7.5).waitMs, 0, 'fractional minutes are accepted');
});

test('minIntervalGate caps a future-dated row at one interval', () => {
  const now = Date.parse('2026-09-25T12:00:00.000Z');
  const g = minIntervalGate({ name: 'Jobicy', min_interval_minutes: 60 }, new Map([['Jobicy', now + 24 * 60 * MIN]]), now);
  assert.equal(g.waitMs, 60 * MIN);
});

test('minIntervalGate flags a setting that is not a positive number', () => {
  const last = new Map([['Jobicy', Date.now()]]);
  for (const bad of [0, -5, '60', Number.NaN, Infinity, true, [60]]) {
    const g = minIntervalGate({ name: 'Jobicy', min_interval_minutes: bad }, last);
    assert.deepEqual(g, { waitMs: 0, invalid: true }, `min_interval_minutes: ${String(bad)}`);
  }
});

test('on a 30-minute schedule, 60 fetches every third run and requests are never under 60 minutes apart', () => {
  // Runs start every 30 min; the request goes out 10s in and the health row is
  // stamped when the run ends, 2-4 min in (it varies run to run).
  const t0 = Date.parse('2026-09-25T09:30:00.000Z');
  const entry = { name: 'Jobicy', min_interval_minutes: 60 };
  const health = [];
  const requests = [];
  for (let run = 0; run < 12; run++) {
    const start = t0 + run * 30 * MIN;
    if (minIntervalGate(entry, lastFetchTimes(health), start).waitMs > 0) continue;
    requests.push(start + 10_000);
    health.push({ timestamp: new Date(start + (2 + (run % 3)) * MIN).toISOString(), company: 'Jobicy', status: 'reachable' });
  }
  const runsFetched = requests.map(ms => (ms - 10_000 - t0) / (30 * MIN));
  assert.deepEqual(runsFetched, [0, 3, 6, 9]);
  for (let i = 1; i < requests.length; i++) assert.ok(requests[i] - requests[i - 1] >= 60 * MIN);
});

// ── End to end through scan.mjs ─────────────────────────────────────────
// The entry names a provider that doesn't exist, so a run that tries to scan
// it reports "unknown provider" and one that defers it reports nothing — no
// network involved either way.

function workspace({ minInterval = 60, healthRows = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-scan-min-interval-'));
  mkdirSync(join(root, 'data'), { recursive: true });
  mkdirSync(join(root, 'config'), { recursive: true });
  writeFileSync(join(root, 'portals.yml'), [
    'tracked_companies: []',
    'job_boards:',
    '  - name: Rate Limited Board',
    '    provider: provider-that-does-not-exist',
    `    min_interval_minutes: ${JSON.stringify(minInterval)}`,
    '',
  ].join('\n'));
  writeFileSync(join(root, 'config', 'profile.yml'), '{}\n');
  if (healthRows.length) {
    writeFileSync(join(root, 'data', 'portal-health.tsv'), 'timestamp\tcompany\tstatus\n'
      + healthRows.map(([agoMin, name]) => `${new Date(Date.now() - agoMin * MIN).toISOString()}\t${name}\treachable\n`).join(''));
  }
  return root;
}

function scan(root, extraArgs = []) {
  const result = spawnSync(process.execPath, [SCAN, '--dry-run', '--json', ...extraArgs], {
    cwd: root,
    env: {
      ...process.env,
      CAREER_OPS_ROOT: root,
      CAREER_OPS_PORTALS: join(root, 'portals.yml'),
      CAREER_OPS_PROFILE: join(root, 'config', 'profile.yml'),
      CAREER_OPS_PIPELINE: join(root, 'data', 'pipeline.md'),
      CAREER_OPS_SCAN_HISTORY: join(root, 'data', 'scan-history.tsv'),
    },
    encoding: 'utf-8',
    maxBuffer: 8 * 1024 * 1024,
  });
  return { ...result, receipt: result.stdout ? JSON.parse(result.stdout) : null };
}

const attempted = (receipt) => receipt.errors.some(e => e.company === 'Rate Limited Board' && /unknown provider/.test(e.error));

test('scan.mjs defers an entry fetched within its min_interval_minutes and says when it is due', () => {
  const root = workspace({ healthRows: [[10, 'Rate Limited Board'], [120, 'Rate Limited Board']] });
  try {
    const { status, receipt, stderr } = scan(root);
    assert.equal(status, 0, stderr);
    assert.equal(attempted(receipt), false);
    assert.deepEqual(receipt.errors, []);
    assert.match(stderr, /⏳ Rate Limited Board: not due — fetched 10 min ago, min_interval_minutes 60; due in 50 min/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('scan.mjs fetches the entry once its interval has passed, or when it has no recorded fetch', () => {
  for (const healthRows of [[[61, 'Rate Limited Board']], [], [[5, 'Some Other Board']]]) {
    const root = workspace({ healthRows });
    try {
      const { receipt, stderr } = scan(root);
      assert.equal(attempted(receipt), true, JSON.stringify(healthRows));
      assert.doesNotMatch(stderr, /not due/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('--ignore-min-interval fetches an entry that is not due yet', () => {
  const root = workspace({ healthRows: [[10, 'Rate Limited Board']] });
  try {
    const { receipt, stderr } = scan(root, ['--ignore-min-interval']);
    assert.equal(attempted(receipt), true);
    assert.doesNotMatch(stderr, /not due/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an invalid min_interval_minutes warns and is ignored rather than dropping the entry', () => {
  const root = workspace({ minInterval: 'sixty', healthRows: [[10, 'Rate Limited Board']] });
  try {
    const { receipt, stderr } = scan(root);
    assert.equal(attempted(receipt), true);
    assert.match(stderr, /Rate Limited Board: min_interval_minutes must be a positive number of minutes, got "sixty" — ignored/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
