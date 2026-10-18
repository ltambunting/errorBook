// `errorbook digest`: the dashboard's numbers as markdown, for a standup note
// or a weekly summary. Read-only -- it reads the notebook and writes nothing
// unless --out names a file.
//
// Every number here comes from ErrorbookStats.summarise(), the same code the
// dashboard page runs, lifted out of dashboard/index.html by its script id the
// way test/dashboard.test.js lifts it. There is deliberately no arithmetic in
// this file: a second copy of the hit rate or the score would drift from the
// page, and then the two would disagree in front of the team. The window is
// applied by filtering the events BEFORE they are summarised, so --days narrows
// the input rather than re-deriving any of the totals.
import nodeFs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { scrub } from '../fingerprint/index.js';
import { createDisplay } from '../cli/display.js';
import * as memory from '../memory/index.js';

const TEMPLATE = fileURLToPath(new URL('../../dashboard/index.html', import.meta.url));
const STATS_BLOCK = /<script id="errorbook-stats">([\s\S]*?)<\/script>/;
const DAY = 86400000;
const DEFAULT_DAYS = 7;
const TOP_ERRORS = 5;
const MAX_TEXT = 140;

// The page's stats module, evaluated as itself. Cached: the file is read once
// per process however many sections ask for it.
let cached = null;
export function loadStats({ fs = nodeFs, file = TEMPLATE } = {}) {
  if (cached) return cached;
  const block = STATS_BLOCK.exec(fs.readFileSync(file, 'utf8'));
  if (!block) throw new Error('dashboard/index.html has no errorbook-stats block');
  // eslint-disable-next-line no-new-func -- evaluating our own page's code on purpose
  cached = new Function(`${block[1]}; return ErrorbookStats;`)();
  return cached;
}

// --- printing ---------------------------------------------------------------

// Notebook text is written by whoever hit the error, and is pasted from a
// terminal. Control characters, newlines and anything non-ASCII are replaced
// here, so one saved fix cannot break the markdown structure or move the cursor
// in a terminal that the digest is catted into.
export const ascii = (text) => String(text ?? '').replace(/[^\x20-\x7e]/g, ' ').replace(/\s+/g, ' ').trim();

const clip = (text) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 3)}...` : text);

// Fix text goes through scrub() first. The store already scrubs a fix on the
// way in, but an older line predates a rule, and a summary was never scrubbed
// at all -- so anything quoted from the notebook is masked again on the way
// out, before it lands in a file that gets pasted into a channel.
export const quote = (text) => clip(ascii(scrub(String(text ?? ''))));

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// --- the report -------------------------------------------------------------

// Events inside the window, by their own timestamp. An event with no usable
// timestamp cannot be placed in a dated window, so it stays out of a report
// whose first line is a date range.
export function withinWindow(events, { days = DEFAULT_DAYS, now = Date.now() } = {}) {
  const since = now - days * DAY;
  return (Array.isArray(events) ? events : []).filter((event) => {
    const at = Date.parse(event?.ts);
    return Number.isFinite(at) && at >= since && at <= now;
  });
}

const EMPTY = [
  '# errorbook digest',
  '',
  'Nothing yet: no notebook entries in this window. Run `errorbook run <command>`',
  'and save a fix the next time something fails.',
  '',
];

export function digest(events, options = {}) {
  const { days = DEFAULT_DAYS, now = Date.now(), stats = loadStats() } = options;
  const windowed = withinWindow(events, { days, now });
  if (!windowed.length) return `${EMPTY.join('\n')}`;

  const summary = stats.summarise(windowed, now, days);
  const name = (author) => ascii(stats.firstName(author));
  const out = [];
  const say = (text = '') => out.push(text);

  say('# errorbook digest');
  say();
  say(`Last ${plural(days, 'day', 'days')}, to ${new Date(now).toISOString().slice(0, 10)}.`);
  say();

  // --- headline
  say('## Headline');
  say();
  say(`- Errors: ${summary.errors.length}`);
  say(`- People: ${summary.people.length}`);
  say(`- Hours lost: ${summary.totalHoursLost}`);
  say();

  // --- hit rate
  const rate = summary.hitRate;
  say('## Hit rate');
  say();
  // summarise() has already chosen the method for this window -- measured when
  // there are lookup lines in it, derived when there are none -- so the only
  // thing decided here is the wording. The two are never mixed in one number,
  // and the method is always stated next to it.
  if (rate.measured) {
    say(rate.percent === null
      ? 'No lookups in this window, so there is no rate to report.'
      : `${rate.percent}% -- ${rate.hits} of ${rate.total} lookups asked the notebook and got an answer back.`);
    say();
    say('Measured from lookups: every `errorbook run` asks the notebook before');
    say('anything else, and what came back is recorded. An exact match and a');
    say('similar one both count as an answer found.');
  } else {
    say(rate.percent === null
      ? 'No encounters in this window, so there is no rate to report.'
      : `${rate.percent}% -- ${rate.hits} of ${rate.total} encounters met an error the notebook already had an answer for.`);
    say();
    say('Derived from the notebook, not measured: the notebook records what people');
    say('saved and voted on, not what they looked up. The first time an error is');
    say('solved counts as a miss and every later encounter with it as a hit.');
  }
  say();

  // --- top errors
  say(`## Top errors (times x people)`);
  say();
  const top = summary.errors.slice(0, TOP_ERRORS);
  if (!top.length) say('None in this window.');
  top.forEach((error, index) => {
    say(`${index + 1}. \`${ascii(error.fingerprint)}\` -- score ${error.score} (${plural(error.occurrences, 'time', 'times')}, ${plural(error.peopleAffected, 'person', 'people')}), ${error.hoursLost} hours lost`);
    if (error.summary) say(`   - ${quote(error.summary)}`);
    const best = error.fixes[0];
    if (best) say(`   - fix (${ascii(best.confidence)}, ${name(best.author)}): ${quote(best.fix)}`);
  });
  say();

  // --- fixes that stopped working
  say('## Fixes that returned or failed');
  say();
  const broken = summary.errors.flatMap((error) =>
    error.fixes
      .filter((fix) => fix.returned || fix.confidence === 'failed')
      .map((fix) => ({ error, fix })));
  if (!broken.length) say('None: no fix in this window was reported failed or as having come back.');
  for (const { error, fix } of broken) {
    const why = fix.returned ? 'the error came back' : 'rejected by the team';
    say(`- \`${ascii(error.fingerprint)}\` ${fix.returned ? 'returned' : 'failed'} (${why}, ${name(fix.author)}): ${quote(fix.fix)}`);
  }
  say();

  // --- who solved what
  say('## Who solved what');
  say();
  const byPerson = new Map(summary.people.map((person) => [person, []]));
  for (const error of summary.errors) {
    for (const fix of error.fixes) {
      if (!byPerson.has(fix.author)) byPerson.set(fix.author, []);
      byPerson.get(fix.author).push(error.fingerprint);
    }
  }
  const solvers = [...byPerson].filter(([, ids]) => ids.length);
  if (!solvers.length) say('Nobody saved a fix in this window.');
  for (const [person, ids] of solvers) {
    const unique = [...new Set(ids)];
    say(`- ${name(person)}: ${plural(unique.length, 'error', 'errors')} (${unique.map((id) => `\`${ascii(id)}\``).join(', ')})`);
  }
  say();

  return out.join('\n');
}

// --- the command ------------------------------------------------------------

// `digest [--days N] [--out FILE]`.
export function parseArgs(argv = []) {
  let days = DEFAULT_DAYS;
  let out = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--days') {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 1) throw new Error(`--days wants a whole number of days, 1 or more`);
      days = value;
      continue;
    }
    if (arg === '--out') {
      out = argv[++i] ?? null;
      if (!out) throw new Error('--out wants a file path');
      continue;
    }
    throw new Error(`Unknown option for digest: ${arg}`);
  }
  return { days, out };
}

export function runDigest(deps = {}) {
  const ui = deps.ui ?? createDisplay();
  const fs = deps.fs ?? nodeFs;
  let options;
  try {
    options = parseArgs(deps.argv ?? []);
  } catch (error) {
    ui.warn(`errorbook digest: ${error.message}`);
    return 1;
  }

  const events = deps.events ?? (deps.memory ?? memory).loadAll();
  const text = digest(events, { days: options.days, now: deps.now ?? Date.now(), ...(deps.stats ? { stats: deps.stats } : {}) });

  if (!options.out) {
    ui.line(text);
    return 0;
  }
  try {
    fs.writeFileSync(options.out, `${text.replace(/\n*$/, '')}\n`);
  } catch (error) {
    ui.warn(`errorbook digest: cannot write ${options.out} (${error.code ?? error.message})`);
    return 1;
  }
  ui.line(`Wrote ${options.out}`);
  return 0;
}
