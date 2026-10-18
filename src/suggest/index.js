// `errorbook suggest`: the errors that have now bitten more than one person,
// and what to change so they stop happening. Read-only.
//
// An error that hits one person is their afternoon; an error that hits two is
// a hole in the project's setup. That is the whole filter -- 2 or more people
// -- and the order is the dashboard's own score, times x people.
//
// The numbers and the ranking come from ErrorbookStats.summarise() via the
// digest's loadStats(), so there is no arithmetic in this file either. What is
// new here is only the mapping from an error type to a recommendation, which is
// a lookup table, not a calculation.
import { loadStats, ascii, quote } from '../digest/index.js';
import { createDisplay } from '../cli/display.js';
import * as memory from '../memory/index.js';

const MIN_PEOPLE = 2;

// --- the recommendation ----------------------------------------------------

// What to change, keyed off the error type the fingerprint recorded. The types
// are matched loosely because they come from different languages' own spelling
// (`missing-script` from npm, `ERR_MODULE_NOT_FOUND` from node), and a new
// runtime should fall into the right bucket without a code change here.
const RULES = [
  {
    name: 'missing-script',
    matches: (type) => /missing[_-]?script/.test(type),
    advice: 'add the script to package.json so it exists for everyone, not just the people who know the command',
  },
  {
    name: 'module-not-found',
    matches: (type) => /module[_-]?not[_-]?found|cannot[_-]?find[_-]?module/.test(type),
    advice: 'add the dependency to package.json and run npm install in setup',
  },
  {
    name: 'port-in-use',
    matches: (type) => /port[_-]?in[_-]?use|e?addr(?:ess)?[_-]?in[_-]?use/.test(type),
    advice: 'document the port or make it configurable',
  },
];

// An UPPER_SNAKE token is how an environment variable is named everywhere. The
// text is scrubbed before this runs, and a token sitting in value position
// (just after an = or a :) is skipped, so what comes back is a key NAME and
// never the thing it was set to.
const ENV_NAME = /(^|[^\w=:])([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/g;

// Env trouble does not have an error type of its own -- it surfaces as a plain
// throw, a ReferenceError or a connection failure -- so this one rule reads the
// text. Either the text talks about the environment, or it names a variable and
// says it is absent.
const ENV_WORDS = /\.env\b|\benv(?:ironment)?\b|\bdotenv\b/i;
const ABSENT = /\b(?:missing|not set|unset|undefined|not defined|required|empty)\b/i;

export function envKeyName(text) {
  const found = [...String(text ?? '').matchAll(ENV_NAME)].map((match) => match[2]);
  return found[0] ?? null;
}

export function isEnvRelated(text) {
  const clean = String(text ?? '');
  if (ENV_WORDS.test(clean)) return true;
  return Boolean(envKeyName(clean)) && ABSENT.test(clean);
}

// The one line of advice for an error. `type` is the fingerprint's errorType;
// `text` is the already-scrubbed summary and fix, read only by the env rule.
export function recommend(type, text = '') {
  const kind = String(type ?? '').toLowerCase();
  for (const rule of RULES) {
    if (kind && rule.matches(kind)) return rule.advice;
  }
  if (isEnvRelated(text)) {
    const name = envKeyName(text);
    // The NAME only. A value never appears here, whatever the notebook holds.
    return name
      ? `add the key name ${name} to .env.example (the name only, never the value)`
      : 'add the missing key name to .env.example (the name only, never the value)';
  }
  return 'document this in the README setup steps';
}

// --- the report ------------------------------------------------------------

// The errors worth acting on: 2 or more people, in summarise()'s own order.
export function recurring(events, { stats = loadStats(), now = Date.now() } = {}) {
  return stats.summarise(Array.isArray(events) ? events : [], now)
    .errors.filter((error) => error.peopleAffected >= MIN_PEOPLE);
}

export function suggest(events, options = {}) {
  const { stats = loadStats(), now = Date.now() } = options;
  const errors = recurring(events, { stats, now });
  const out = [];
  const say = (text = '') => out.push(text);

  say('errorbook suggest');
  say();
  if (!errors.length) {
    say('Nothing recurring yet: no error here has hit two or more people.');
    return out.join('\n');
  }

  say(`${errors.length} ${errors.length === 1 ? 'error has' : 'errors have'} hit ${MIN_PEOPLE} or more people, worst first.`);
  say();
  errors.forEach((error, index) => {
    const fix = error.fixes[0];
    // Scrubbed on the way out: the store masks a fix when it is saved, but an
    // older line predates a rule and a summary was never masked at all.
    const summary = quote(error.summary);
    const fixText = fix ? quote(fix.fix) : null;

    say(`${index + 1}. ${ascii(error.fingerprint)} -- ${error.occurrences} times x ${error.peopleAffected} people = ${error.score}`);
    say(`   ${summary || '(no summary saved for this error)'}`);
    say(fixText
      ? `   fix (${ascii(fix.confidence)}, ${ascii(stats.firstName(fix.author))}): ${fixText}`
      : '   fix: none saved yet');
    // The recommendation reads the scrubbed text, never the raw line.
    say(`   Fix this at the source: ${ascii(recommend(error.loose?.errorType, `${summary} ${fixText ?? ''}`))}`);
    say();
  });

  return out.join('\n');
}

// --- the command -----------------------------------------------------------

export function runSuggest(deps = {}) {
  const ui = deps.ui ?? createDisplay();
  const events = deps.events ?? (deps.memory ?? memory).loadAll();
  ui.line(suggest(events, {
    now: deps.now ?? Date.now(),
    ...(deps.stats ? { stats: deps.stats } : {}),
  }));
  return 0;
}
