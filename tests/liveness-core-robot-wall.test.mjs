// tests/liveness-core-robot-wall.test.mjs — IBM's "verify that you're not a
// robot" wall must read as uncertain, never expired.
//
// careers.ibm.com (Confluent's postings since IBM bought it, 2026-10-21)
// answers a plain fetch with HTTP 202 and a 28-word interstitial. None of the
// Cloudflare/hCaptcha patterns matched it, so it fell through to
// insufficient_content → expired, and every live posting there looked closed.
import { pass, fail } from './helpers.mjs';
import { classifyLiveness } from '../liveness-core.mjs';

console.log('\nliveness-core — IBM "verify that you\'re not a robot" wall is uncertain');

const IBM_WALL = 'JavaScript is disabled In order to continue, we need to verify that you’re not a robot. '
  + 'This requires JavaScript. Enable JavaScript and then reload the page.';

const wall = classifyLiveness({
  status: 202,
  finalUrl: 'https://careers.ibm.com/en_US/careers/JobDetail?jobId=135407',
  bodyText: IBM_WALL,
  applyControls: [],
});
wall.result === 'uncertain' && wall.code === 'bot_challenge'
  ? pass('IBM robot wall (curly apostrophe) -> uncertain / bot_challenge (was: expired)')
  : fail(`IBM robot wall classified ${wall.result} (${wall.code})`);

const straight = classifyLiveness({ status: 202, bodyText: IBM_WALL.replace('’', "'"), applyControls: [] });
straight.code === 'bot_challenge'
  ? pass('IBM robot wall (straight apostrophe) -> bot_challenge')
  : fail(`straight-apostrophe wall classified ${straight.result} (${straight.code})`);

// A live posting whose application form carries a reCAPTCHA "I'm not a robot"
// label must not be downgraded to uncertain.
const live = classifyLiveness({
  status: 200,
  finalUrl: 'https://careers.example.com/job/42',
  bodyText: 'Engineering Manager. '.repeat(40) + "Submit your application. I'm not a robot",
  applyControls: ['Apply now'],
});
live.result === 'active'
  ? pass('a live posting with a reCAPTCHA "I\'m not a robot" label stays active')
  : fail(`reCAPTCHA label downgraded a live posting to ${live.result} (${live.code})`);
