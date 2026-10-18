// Regenerates src/explainer/seed-cache.json: the committed explanations for the
// four errors the demo relies on, so the demo works with no key and no network.
//
//   node scripts/seed-explanations.mjs            all four
//   node scripts/seed-explanations.mjs 6ce249     just one
//
// Needs GEMINI_API_KEY and demo/project (run demo/reset.sh first). The four
// errors are captured by actually running the failing commands, so the
// fingerprints are the ones the demo produces rather than ones assumed here.
// Calls are spaced out, because the free tier is rate limited.
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runCommand } from '../src/capture/index.js';
import { contextFromFailure } from '../src/explainer/context.js';
import { aiAdapter } from '../src/explainer/aiAdapter.js';
import { validateExplanation } from '../src/explainer/validate.js';

const PROJECT = fileURLToPath(new URL('../demo/project', import.meta.url));
const SEED = fileURLToPath(new URL('../src/explainer/seed-cache.json', import.meta.url));
const GAP_MS = 6000;          // between cases, to stay under the free-tier rate
const RETRY_MS = 10000;       // before the single retry
const SEED_TIMEOUT_MS = 15000; // seeding only; the live CLI stays at 5s

if (!existsSync(PROJECT)) {
  console.error('demo/project is missing. Run demo/reset.sh first.');
  process.exit(1);
}
if (!process.env.GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY is not set.');
  process.exit(1);
}

// Runs the command through errorbook's own capture module, in the demo project.
// Going through spawn directly here would reintroduce the Windows quoting bug
// capture exists to solve: with shell:true, `C:\Program Files\nodejs\node.exe`
// splits at the space and the error captured is the shell's, not the project's.
process.chdir(PROJECT);
function capture(argv) {
  return new Promise((resolve, reject) => {
    let report = null;
    runCommand(argv, { onFailure: (r) => { report = r; } })
      .then((code) => resolve({ stderr: report?.stderr ?? '', code }))
      .catch(reject);
  });
}

// Port 3000 has to be taken by someone else for the collision to happen. If
// something already holds it, that does the job for us: never kill it, because
// it may be the user's own server.
async function capturePortInUse() {
  let holder = createServer(() => {});
  try {
    await new Promise((resolve, reject) => {
      holder.once('error', reject);
      holder.listen(3000, resolve);
    });
  } catch (e) {
    if (e.code !== 'EADDRINUSE') throw e;
    console.warn('  something already holds port 3000; using it rather than touching it');
    holder = null;
  }
  try {
    return await capture([process.execPath, 'server.js']);
  } finally {
    if (holder) await new Promise((resolve) => holder.close(resolve));
  }
}

const CASES = [
  { id: '6ce249', label: 'npm missing script', run: () => capture(['npm', 'run', 'build']) },
  { id: 'fb4768', label: 'module not found', run: () => capture([process.execPath, 'app.mjs']) },
  { id: '28b25a', label: 'port already in use', run: capturePortInUse },
  { id: 'b540a5', label: 'git identity unset', run: () => capture(['git', 'commit', '-m', 'seed']) },
];

const only = process.argv.slice(2);
const wanted = only.length ? CASES.filter((c) => only.includes(c.id) || only.includes(c.label)) : CASES;
if (!wanted.length) {
  console.error(`No such case. Known: ${CASES.map((c) => c.id).join(', ')}`);
  process.exit(1);
}

// Re-read and re-merge before every write, so a run that dies partway through
// keeps whatever it already earned, and two cases cannot clobber each other.
function load() {
  try {
    const existing = JSON.parse(readFileSync(SEED, 'utf8'));
    if (existing?.schemaVersion === 1 && existing.entries) return existing;
  } catch { /* first run */ }
  return { schemaVersion: 1, entries: {} };
}
function save(id, entry) {
  const seed = load();
  seed.entries[id] = entry;
  writeFileSync(SEED, JSON.stringify(seed, null, 2) + '\n');
  return Object.keys(seed.entries).length;
}

let failures = 0, calls = 0;
for (const kase of wanted) {
  // Already seeded: an explicit id on the command line re-does it, a bare run
  // leaves it alone. That way a rate-limited run can simply be repeated.
  if (!only.length && load().entries[kase.id]) {
    console.log(`${kase.id} ${kase.label}: already seeded, skipping`);
    continue;
  }
  if (calls > 0) await new Promise((r) => setTimeout(r, GAP_MS));

  const { stderr, code } = await kase.run();
  const event = contextFromFailure({ stderr, exitCode: code, durationMs: 0 });
  if (!event) {
    console.error(`${kase.id} ${kase.label}: produced no stderr to fingerprint`);
    failures++;
    continue;
  }
  if (event.errorId !== kase.id) {
    console.error(`${kase.id} ${kase.label}: captured ${event.errorId} instead. Not saving.`);
    failures++;
    continue;
  }

  // Seeding is a one-off offline step, so it is allowed to wait longer than the
  // CLI does: 15s here, against the live path's untouched 5s. A timeout or a
  // 429 is the free tier being uneven, so it gets one more go after 10s.
  const startedAt = Date.now();
  let value, last;
  for (let attempt = 1; attempt <= 2 && !value; attempt++) {
    if (attempt > 1) await new Promise((r) => setTimeout(r, RETRY_MS));
    calls++;
    try {
      value = validateExplanation(await aiAdapter(event, { timeoutMs: SEED_TIMEOUT_MS }));
    } catch (e) {
      last = e;
      if (!['timeout', 'http_error'].includes(e.reason)) break;
      if (attempt === 1) console.error(`  ${kase.id} attempt 1: ${e.reason}, retrying in ${RETRY_MS / 1000}s`);
    }
  }
  if (!value) {
    console.error(`${kase.id} ${kase.label}: ${last?.reason ?? 'failed'} - ${last?.message}`);
    failures++;
    continue;
  }

  const total = save(event.errorId, {
    ...value,
    // Provenance, so a stale or hand-edited entry is obvious later. No key, no
    // request, nothing machine-specific.
    _source: {
      label: kase.label,
      model: process.env.ERRORBOOK_AI_MODEL || 'gemini-3.8-flash',
      generatedAt: new Date().toISOString(),
      summary: event.summary,
    },
  });
  console.log(`${kase.id} ${kase.label}  (${Date.now() - startedAt}ms, saved, ${total} total)`);
  console.log(`  ${value.explanation}`);
  value.suggestedSteps.forEach((s) => console.log(`  -> ${s}`));
}

const seeded = Object.keys(load().entries).sort();
console.log(`\n${SEED}\nseeded: ${seeded.join(', ') || '(none)'}`);
process.exit(failures ? 1 : 0);
