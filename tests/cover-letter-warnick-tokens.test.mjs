// tests/cover-letter-warnick-tokens.test.mjs — the resume-matched cover-letter
// tokens (local addition to generate-cover-letter.mjs, 2026-10-16).
//
// templates/cover-letter-template.warnick.html reuses the CV's letterhead: a
// two-tone name, the CV's icon contact row (one classed element per item, no
// "|" separator text), embedded custom fonts and a long-form date. These
// tokens are additive: the base template uses none of them, so a letter built
// from it must come out exactly as before even when the payload carries the
// new fields.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHtml, buildContactItems, buildCustomFonts, formatLongDate } from '../generate-cover-letter.mjs';
import { resolveTemplate } from '../cv-templates.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = join(ROOT, 'templates', 'cover-letter-template.html');
const WARNICK = join(ROOT, 'templates', 'cover-letter-template.warnick.html');

const payload = (extra = {}) => ({
  candidate: {
    name: 'Jane Doe',
    email: 'jane@example.test',
    linkedin: 'https://www.linkedin.com/in/janedoe/',
    website: 'https://janedoe.example',
    phone: '+1 (555) 010-0199',
  },
  letter: {
    role_title: 'Engineering Manager',
    company: 'Acme',
    city: 'Remote',
    date: '2026-10-16',
    opening: 'Opening paragraph.',
    profile_intro: 'Intro paragraph. Here are some highlights:',
    achievements: [{ lead: 'Raising the bar', impact: 'I reworked our testing.' }],
    problems_section: 'Why-me paragraph.',
    closing: 'Closing line.',
  },
  ...extra,
});

test('the warnick template is a valid, resolvable cover template', () => {
  assert.equal(resolveTemplate('cover', 'warnick', { format: 'html' }), WARNICK);
});

test('base template output is unchanged by the new payload fields', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cover-warnick-'));
  const font = join(dir, 'Fake-Thin.ttf');
  writeFileSync(font, Buffer.from([0, 1, 0, 0]));
  const plain = buildHtml(payload(), BASE);
  const withFonts = buildHtml(payload({ custom_fonts: [{ family: 'Roboto', weight: 100, path: font }] }), BASE);
  assert.equal(withFonts, plain);
  assert.ok(!plain.includes('@font-face'));
  assert.ok(!plain.includes('contact-email'));
});

test('warnick letterhead: two-tone name, classed contacts in resume order, no separators', () => {
  const html = buildHtml(payload(), WARNICK);
  assert.match(html, /<span class="name-first">Jane<\/span> <span class="name-last">Doe<\/span>/);
  const order = ['contact-email', 'contact-linkedin', 'contact-portfolio', 'contact-phone'].map((c) => html.indexOf(`class="${c}"`));
  assert.ok(order.every((i) => i > 0), 'every contact item rendered');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'email, LinkedIn, website, phone');
  assert.match(html, />linkedin\.com\/in\/janedoe</);
  assert.match(html, />janedoe\.example</);
  assert.match(html, /href="tel:\+15550100199"/);
  const row = html.slice(html.indexOf('<div class="contact-row">'), html.indexOf('</header>'));
  assert.ok(!row.includes('|'), 'no "|" separator text in the contact row');
  assert.ok(!/\{\{[A-Z_]+\}\}/.test(html), 'no unresolved tokens');
});

test('warnick meta line: company and city joined, long-form date', () => {
  const html = buildHtml(payload(), WARNICK);
  assert.match(html, /<span class="meta-company">Acme · Remote<\/span>/);
  assert.match(html, /<div class="meta-date">October 16, 2026<\/div>/);
  const noCity = buildHtml(payload({ letter: { ...payload().letter, city: '' } }), WARNICK);
  assert.match(noCity, /<span class="meta-company">Acme<\/span>/);
});

test('formatLongDate: ISO dates become long form, anything else passes through escaped', () => {
  assert.equal(formatLongDate('2026-01-05'), 'January 5, 2026');
  assert.equal(formatLongDate('2026-13-01'), '2026-13-01');
  assert.equal(formatLongDate('Oct <16>'), 'Oct &lt;16&gt;');
  assert.equal(formatLongDate(''), '');
});

test('custom fonts are inlined; unreadable or unsupported files are skipped, not fatal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cover-fonts-'));
  const font = join(dir, 'Fake-Thin.ttf');
  writeFileSync(font, Buffer.from([0, 1, 0, 0]));
  const css = buildCustomFonts([
    { family: 'Roboto"<x>', weight: 100, path: font },
    { family: 'Roboto', weight: 400, path: join(dir, 'missing.ttf') },
    { family: 'Roboto', weight: 400, path: join(dir, 'font.exe') },
  ]);
  assert.equal((css.match(/@font-face/g) || []).length, 1);
  assert.match(css, /font-family: "Robotox"; font-weight: 100; font-style: normal; src: url\(data:font\/ttf;base64,AAEAAA==\) format\("truetype"\)/);
  assert.equal(buildCustomFonts(undefined), '');
});

test('contact items escape user text', () => {
  const html = buildContactItems({ email: 'a"<b>@x.test', phone: '<1>' });
  assert.ok(!html.includes('<b>'));
  assert.match(html, /a&quot;&lt;b&gt;@x\.test/);
  assert.match(html, />&lt;1&gt;<\/a>/);
});
