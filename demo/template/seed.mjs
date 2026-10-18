// Writes the demo's starting notebook: two teammates, five real errors, and a
// fortnight of history. Run by reset.sh; not part of the demo itself.
//
// The lines go in through the notebook's own append(), so the fixIds, the author
// slugs and the scrubbing are exactly what the tool would have written. Dates
// are relative to today, so the dashboard's two-week timeline is never stale.
//
// The fingerprints are real: every one was captured from an actual failure.
// 6ce249 and fb4768 are the demo's own broken states 1 and 2. The other three
// are ordinary errors from a working week, so the dashboard has something to
// rank. Broken states 3 (EADDRINUSE, 28b25a) and 4 (git identity, 27dfb3) are
// deliberately absent -- those demonstrate a miss, the AI fallback and saving.
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';

// reset.sh passes the notebook folder to write into.
const notebook = process.argv[2] ?? fileURLToPath(new URL('../project/.errorbook', import.meta.url));
rmSync(notebook, { recursive: true, force: true });
process.env.ERRORBOOK_DIR = notebook;
const { append } = await import('../../src/memory/index.js');

const DAY = 86400_000;
// Whole days back from this morning, so the ordering is stable all day.
const midnight = new Date().setHours(9, 0, 0, 0);
const daysAgo = (days, hours = 0) => new Date(midnight - days * DAY + hours * 3600_000).toISOString();

const ANKIT = 'Ankit Aggarwal';
const LOUISA = 'Louisa Tambunting';

const ERRORS = {
  build: {
    fingerprint: '6ce249',
    loose: { lang: 'npm', errorType: 'missing-script', file: null },
    summary: 'npm error missing script: "build"',
    raw: 'npm error Missing script: "build"\nnpm error\nnpm error To see a list of scripts, run:\nnpm error   npm run\n',
  },
  module: {
    fingerprint: 'fb4768',
    loose: { lang: 'node', errorType: 'ERR_MODULE_NOT_FOUND', file: 'app.mjs' },
    summary: "error [err_module_not_found]: cannot find package 'express' imported from app.mjs",
    raw: "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'express' imported from ~/demo/app.mjs\n    at packageResolve (node:internal/modules/esm/resolve:768:81)\n",
  },
  cart: {
    fingerprint: '204e89',
    loose: { lang: 'node', errorType: 'TypeError', file: 'cart.js' },
    summary: 'typeerror: cannot read properties of undefined (reading "reduce")',
    raw: 'TypeError: Cannot read properties of undefined (reading "reduce")\n    at cartTotal (~/work/app/src/cart.js:42:25)\n',
  },
  db: {
    fingerprint: '65975b',
    loose: { lang: 'node', errorType: 'ECONNREFUSED', file: null },
    summary: 'error: connect econnrefused 127.0.0.1:5432',
    raw: 'Error: connect ECONNREFUSED 127.0.0.1:5432\n    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1611:16)\n',
  },
  eslint: {
    fingerprint: '20116d',
    loose: { lang: 'node', errorType: null, file: 'eslint.config.js' },
    summary: 'oops! something went wrong! :(',
    raw: 'Oops! Something went wrong! :(\n\nESLint: 9.12.0\n\nError: Cannot find package "eslint-config-airbnb" imported from ~/work/app/eslint.config.js\n',
  },
};

const solved = (error, { fix, author, ts, timeToSolve }) =>
  append({ type: 'solved', ...ERRORS[error], fix, author, ts, timeToSolve, versions: { node: '22.17.0' } });

const vote = (type, error, { fixId, author, ts }) =>
  append({ type, fingerprint: ERRORS[error].fingerprint, fixId, author, ts });

// --- 6ce249: the error with two competing fixes ---------------------------
// Ankit's works and Louisa has confirmed it; Louisa's own guess was rejected,
// so it ranks below but is still shown. A dead end is worth knowing about.
const buildFix = solved('build', {
  fix: 'Add a build script to package.json: "build": "tsc -p ."',
  author: ANKIT, ts: daysAgo(12), timeToSolve: 1380,
});
const buildGuess = solved('build', {
  fix: 'Reinstall node_modules',
  author: LOUISA, ts: daysAgo(11, 2), timeToSolve: 2700,
});
vote('confirmed', 'build', { fixId: buildFix.fixId, author: LOUISA, ts: daysAgo(9) });
vote('rejected', 'build', { fixId: buildGuess.fixId, author: ANKIT, ts: daysAgo(3, 5) });

// --- fb4768: a straightforward confirmed fix ------------------------------
const moduleFix = solved('module', {
  fix: 'Run npm install express. It is imported in app.mjs but missing from package.json.',
  author: LOUISA, ts: daysAgo(10, 1), timeToSolve: 600,
});
vote('confirmed', 'module', { fixId: moduleFix.fixId, author: ANKIT, ts: daysAgo(8) });

// --- 204e89: a fix that worked, then stopped working ----------------------
const cartFix = solved('cart', {
  fix: 'Guard the list before reducing: (items ?? []).reduce(...)',
  author: ANKIT, ts: daysAgo(13), timeToSolve: 3300,
});
vote('confirmed', 'cart', { fixId: cartFix.fixId, author: LOUISA, ts: daysAgo(6) });
vote('returned', 'cart', { fixId: cartFix.fixId, author: LOUISA, ts: daysAgo(2, 3) });

// --- 65975b: the database was simply not running --------------------------
const dbFix = solved('db', {
  fix: 'Start the database first: docker compose up -d db',
  author: LOUISA, ts: daysAgo(7, 4), timeToSolve: 900,
});
vote('confirmed', 'db', { fixId: dbFix.fixId, author: ANKIT, ts: daysAgo(5) });

// --- 20116d: nobody has checked this one yet ------------------------------
solved('eslint', {
  fix: 'npm i -D eslint-config-airbnb',
  author: ANKIT, ts: daysAgo(4, 6), timeToSolve: 420,
});

console.log('Seeded .errorbook/ with 2 teammates and 5 errors.');
