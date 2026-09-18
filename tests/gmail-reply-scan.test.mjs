import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pass, fail, ROOT } from './helpers.mjs';

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function authHeaders() {
  return [{ name: 'Authentication-Results', value: 'mx.google.com; dmarc=pass (p=REJECT)' }];
}

/** A minimal fake Gmail API: token exchange, one page of message ids, per-id detail. */
function makeFetch(details) {
  return async (url) => {
    if (url.includes('oauth2')) return { ok: true, json: async () => ({ access_token: 'fake' }) };
    if (url.includes('/messages?')) {
      return { ok: true, json: async () => ({ messages: Object.keys(details).map((id) => ({ id })) }) };
    }
    const match = /\/messages\/([^?]+)\?/.exec(url);
    if (match) {
      const id = match[1];
      return { ok: true, json: async () => details[id] || { payload: { headers: [] } } };
    }
    return { ok: true, json: async () => ({}) };
  };
}

test('gmail-reply-scan: appends a candidate that matches an active tracker row, skips one that does not (#1583)', async () => {
  const { scan } = await import(pathToFileURL(join(ROOT, 'gmail-reply-scan.mjs')).href);

  const details = {
    'msg-match': {
      payload: {
        headers: [
          ...authHeaders(),
          { name: 'Subject', value: 'Update on your application to Acme Corp' },
          { name: 'From', value: 'hr@acme.test' },
        ],
        body: { data: Buffer.from('Unfortunately we have decided not to move forward with your application.').toString('base64') },
      },
    },
    'msg-unrelated': {
      payload: {
        headers: [
          ...authHeaders(),
          { name: 'Subject', value: 'Your weekly newsletter' },
          { name: 'From', value: 'news@somewhere-else.test' },
        ],
        body: { data: Buffer.from('Totally unrelated content.').toString('base64') },
      },
    },
  };

  const dir = tmp('co-gmail-reply-scan-');
  try {
    const candidatesPath = join(dir, 'reply-candidates.json');
    const statePath = join(dir, 'state.json');
    const apps = [{ num: 1, company: 'Acme Corp', role: 'Engineering Manager', status: 'Applied', notes: '' }];

    const result = await scan({
      clientId: 'x', clientSecret: 'y', refreshToken: 'z', apps, followups: [],
      fetchFn: makeFetch(details), candidatesPath, statePath, log: () => {},
    });

    const written = JSON.parse(readFileSync(candidatesPath, 'utf8'));
    const ok = result.added === 1 && result.skippedNoMatch === 1
      && written.length === 1 && written[0].message_id === 'gmail-msg-match'
      && written[0].from === 'hr@acme.test';
    if (ok) {
      pass('gmail-reply-scan: only the tracker-matching message is appended');
    } else {
      fail(`gmail-reply-scan match filter broken: result=${JSON.stringify(result)}, written=${JSON.stringify(written)}`);
      assert.fail('gmail-reply-scan match filter broken');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gmail-reply-scan: dedups via its own state file across repeated scans (#1583)', async () => {
  const { scan } = await import(pathToFileURL(join(ROOT, 'gmail-reply-scan.mjs')).href);

  const details = {
    'msg-match': {
      payload: {
        headers: [
          ...authHeaders(),
          { name: 'Subject', value: 'Interview invitation — Acme Corp' },
          { name: 'From', value: 'hr@acme.test' },
        ],
        body: { data: Buffer.from('We would like to schedule an interview.').toString('base64') },
      },
    },
  };

  const dir = tmp('co-gmail-reply-scan-dedup-');
  try {
    const candidatesPath = join(dir, 'reply-candidates.json');
    const statePath = join(dir, 'state.json');
    const apps = [{ num: 1, company: 'Acme Corp', role: 'Engineering Manager', status: 'Applied', notes: '' }];

    const first = await scan({
      clientId: 'x', clientSecret: 'y', refreshToken: 'z', apps, followups: [],
      fetchFn: makeFetch(details), candidatesPath, statePath, log: () => {},
    });
    const second = await scan({
      clientId: 'x', clientSecret: 'y', refreshToken: 'z', apps, followups: [],
      fetchFn: makeFetch(details), candidatesPath, statePath, log: () => {},
    });

    const written = JSON.parse(readFileSync(candidatesPath, 'utf8'));
    if (first.added === 1 && second.added === 0 && written.length === 1) {
      pass('gmail-reply-scan: a previously-seen message id is never re-appended');
    } else {
      fail(`gmail-reply-scan dedup broken: first=${JSON.stringify(first)}, second=${JSON.stringify(second)}, written.length=${written.length}`);
      assert.fail('gmail-reply-scan dedup broken');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gmail-reply-scan: skips an unauthenticated (DMARC-failing) sender (#1583)', async () => {
  const { scan } = await import(pathToFileURL(join(ROOT, 'gmail-reply-scan.mjs')).href);

  const details = {
    'msg-spoofed': {
      payload: {
        headers: [
          { name: 'Authentication-Results', value: 'mx.google.com; dmarc=fail' },
          { name: 'Subject', value: 'Update on your application to Acme Corp' },
          { name: 'From', value: 'hr@acme.test' },
        ],
        body: { data: Buffer.from('Unfortunately we have decided not to move forward.').toString('base64') },
      },
    },
  };

  const dir = tmp('co-gmail-reply-scan-spoof-');
  try {
    const candidatesPath = join(dir, 'reply-candidates.json');
    const statePath = join(dir, 'state.json');
    const apps = [{ num: 1, company: 'Acme Corp', role: 'Engineering Manager', status: 'Applied', notes: '' }];

    const result = await scan({
      clientId: 'x', clientSecret: 'y', refreshToken: 'z', apps, followups: [],
      fetchFn: makeFetch(details), candidatesPath, statePath, log: () => {},
    });

    if (result.added === 0 && result.skippedUnauthenticated === 1 && !existsSync(candidatesPath)) {
      pass('gmail-reply-scan: a DMARC-failing sender is never turned into a candidate');
    } else {
      fail(`gmail-reply-scan spoof guard broken: result=${JSON.stringify(result)}`);
      assert.fail('gmail-reply-scan spoof guard broken');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gmail-reply-scan: loadActiveApps keeps only non-terminal statuses (#1583)', async () => {
  const { loadActiveApps } = await import(pathToFileURL(join(ROOT, 'gmail-reply-scan.mjs')).href);

  const dir = tmp('co-gmail-reply-scan-tracker-');
  try {
    const trackerPath = join(dir, 'applications.md');
    mkdirSync(dir, { recursive: true });
    writeFileSync(trackerPath, [
      '# Applications Tracker',
      '',
      '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
      '|---|------|---------|------|-------|--------|-----|--------|-------|',
      '| 1 | 2026-08-01 | Acme | EM | 4.0/5 | Applied | ✅ | — | — |',
      '| 2 | 2026-08-01 | Beta | EM | 4.0/5 | Rejected | ✅ | — | — |',
      '| 3 | 2026-08-01 | Gamma | EM | 4.0/5 | Interview | ✅ | — | — |',
    ].join('\n'));

    const apps = loadActiveApps(trackerPath);
    const companies = apps.map((a) => a.company).sort();
    if (companies.length === 2 && companies[0] === 'Acme' && companies[1] === 'Gamma') {
      pass('gmail-reply-scan: loadActiveApps excludes terminal-status rows');
    } else {
      fail(`loadActiveApps included the wrong rows: ${JSON.stringify(companies)}`);
      assert.fail('loadActiveApps included the wrong rows');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
