// Covers `errorbook suggest`: the errors that have hit more than one person,
// and the one-line change that would stop each of them.
//
// The ranking and the counts are summarise()'s, so as in the digest's suite the
// expected numbers are read out of summarise() rather than written here. What
// is tested in its own right is the rule table -- which recommendation an error
// type earns -- and the standing promise that an env VALUE never reaches the
// output, only a key name.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { runCli } from "../src/cli/cli.js";
import { createDisplay } from "../src/cli/display.js";
import { append } from "../src/memory/index.js";
import { loadStats } from "../src/digest/index.js";
import { suggest, runSuggest, recommend, recurring, envKeyName, isEnvRelated } from "../src/suggest/index.js";

// Nothing here may depend on the caller's shell. A developer with
// ERRORBOOK_DIR exported for their own notebook, or ERRORBOOK_AUTHOR_NAME set
// for a demo, would otherwise have this suite report on their real notebook.
// Cleared first, pointed at a temp folder, restored at the end.
const INHERITED = ["ERRORBOOK_DIR", "ERRORBOOK_AUTHOR", "ERRORBOOK_AUTHOR_NAME", "ERRORBOOK_AUTHOR_EMAIL"];
const callerEnv = Object.fromEntries(INHERITED.map((key) => [key, process.env[key]]));
for (const key of INHERITED) delete process.env[key];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "errorbook-suggest-"));
process.env.ERRORBOOK_DIR = dir;

after(() => {
  for (const key of INHERITED) {
    if (callerEnv[key] === undefined) delete process.env[key];
    else process.env[key] = callerEnv[key];
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

function sink() {
  const out = [], err = [];
  const stream = (bucket) => new Writable({ write(c, e, cb) { bucket.push(c.toString()); cb(); } });
  return { out: stream(out), err: stream(err), stdout: () => out.join(""), stderr: () => err.join("") };
}

const S = loadStats();
const NOW = Date.parse("2026-10-18T09:00:00Z");
const DAY = 86400000;
const daysAgo = (d, h = 0) => new Date(NOW - d * DAY + h * 3600000).toISOString();
const report = (events) => suggest(events, { now: NOW });

// An error, as the notebook records one: a saved fix plus however many other
// people met it. `people` are the teammates who confirmed it, which is what
// makes an error "shared" rather than one person's afternoon.
function error({ id, type, summary, fix, author = "ankit-aggarwal", people = [], seconds = 600 }) {
  const events = [{
    type: "solved", fingerprint: id, fixId: `${id}-1`, fix, author, ts: daysAgo(6),
    timeToSolve: seconds, summary, loose: { lang: "npm", errorType: type, file: null },
  }];
  people.forEach((person, i) => {
    events.push({ type: "confirmed", fingerprint: id, fixId: `${id}-1`, author: person, ts: daysAgo(5 - i) });
  });
  return events;
}

const MISSING_SCRIPT = error({
  id: "6ce249", type: "missing-script", summary: 'npm error missing script: "build"',
  fix: "Add a build script to package.json", people: ["louisa-tambunting"],
});
const MODULE_MISSING = error({
  id: "fb4768", type: "ERR_MODULE_NOT_FOUND", summary: "cannot find package 'express'",
  fix: "npm i express", people: ["louisa-tambunting", "sam-reed"],
});
// One person only: present in the notebook, absent from this report.
const SOLO = error({
  id: "20116d", type: "TypeError", summary: "typeerror: cannot read properties of undefined",
  fix: "Guard the list", people: [],
});

// --- the rule table --------------------------------------------------------

test("each error type earns its own recommendation", () => {
  assert.match(recommend("missing-script"), /add the script to package\.json/);
  assert.match(recommend("ERR_MODULE_NOT_FOUND"), /add the dependency to package\.json and run npm install in setup/);
  assert.match(recommend("EADDRINUSE"), /document the port or make it configurable/);
  assert.match(recommend("port-in-use"), /document the port or make it configurable/);
});

test("a type is matched however its runtime spells it", () => {
  for (const type of ["missing-script", "MISSING_SCRIPT", "npm-missing-script"]) {
    assert.match(recommend(type), /add the script/, type);
  }
  for (const type of ["ERR_MODULE_NOT_FOUND", "module-not-found", "MODULE_NOT_FOUND", "cannot-find-module"]) {
    assert.match(recommend(type), /add the dependency/, type);
  }
});

test("anything unrecognised falls back to the README", () => {
  assert.equal(recommend("TypeError"), "document this in the README setup steps");
  assert.equal(recommend(null), "document this in the README setup steps");
  assert.equal(recommend(undefined, ""), "document this in the README setup steps");
  assert.equal(recommend("SyntaxError", "unexpected token"), "document this in the README setup steps");
});

// --- the env rule ----------------------------------------------------------

test("env trouble is recognised from the text and answered with the key NAME", () => {
  const advice = recommend("Error", "Missing environment variable DATABASE_URL");
  assert.match(advice, /add the key name DATABASE_URL to \.env\.example/);
  assert.match(advice, /the name only, never the value/);
});

test("an env error with no name in it still points at .env.example", () => {
  assert.match(recommend(null, "dotenv could not load the environment"), /add the missing key name to \.env\.example/);
});

test("a bare upper-snake token is only env trouble when the text says it is absent", () => {
  assert.ok(isEnvRelated("API_KEY is not set"));
  assert.ok(isEnvRelated("required variable REDIS_URL missing"));
  assert.ok(!isEnvRelated("THIS_IS_SHOUTING in a log line"), "a loud log line is not an env error");
  assert.equal(recommend("TypeError", "SOME_CONSTANT was fine"), "document this in the README setup steps");
});

test("envKeyName takes the name and never a value standing next to it", () => {
  assert.equal(envKeyName("DATABASE_URL is not set"), "DATABASE_URL");
  // The token in value position is skipped, so the name is what comes back.
  assert.equal(envKeyName("API_KEY=SOME_SECRET_VALUE"), "API_KEY");
  assert.equal(envKeyName("export STRIPE_KEY: LIVE_KEY_ABC"), "STRIPE_KEY");
  assert.equal(envKeyName("nothing here"), null);
});

test("an env value in the notebook never reaches the output", () => {
  const events = error({
    id: "aa1111", type: "Error",
    summary: "Error: missing environment variable STRIPE_SECRET_KEY",
    fix: "export STRIPE_SECRET_KEY=sk-live-0123456789abcdefghijklmn and restart",
    people: ["louisa-tambunting"],
  });
  const md = report(events);
  assert.ok(!md.includes("sk-live-0123456789abcdefghijklmn"), "the value is not in the report");
  assert.match(md, /\[redacted\]/, "the fix text was scrubbed on the way out");
  assert.match(md, /Fix this at the source: add the key name STRIPE_SECRET_KEY to \.env\.example/);
});

// --- the filter and the order ---------------------------------------------

test("only errors that hit two or more people are listed", () => {
  const events = [...MISSING_SCRIPT, ...MODULE_MISSING, ...SOLO];
  const shared = recurring(events, { now: NOW });
  assert.deepEqual(shared.map((e) => e.fingerprint), ["fb4768", "6ce249"]);

  const md = report(events);
  assert.ok(!md.includes("20116d"), "the error only one person met is not a project problem");
  assert.match(md, /2 errors have hit 2 or more people, worst first/);
});

test("the order and the counts are summarise()'s, highest score first", () => {
  const events = [...MISSING_SCRIPT, ...MODULE_MISSING, ...SOLO];
  const expected = S.summarise(events, NOW).errors.filter((e) => e.peopleAffected >= 2);
  const md = report(events);

  const listed = [...md.matchAll(/^\d+\. ([0-9a-f]+) --/gm)].map((m) => m[1]);
  assert.deepEqual(listed, expected.map((e) => e.fingerprint), "same errors, same order as the dashboard");
  for (const e of expected) {
    assert.match(md, new RegExp(`${e.fingerprint} -- ${e.occurrences} times x ${e.peopleAffected} people = ${e.score}`));
  }
  // Guard against the assertion passing on a one-item list.
  assert.equal(expected.length, 2);
  assert.ok(expected[0].score > expected[1].score, "the worst one really is first");
});

// --- what each entry prints -----------------------------------------------

test("each entry prints the fingerprint, the summary, the saved fix and one recommendation", () => {
  const md = report(MISSING_SCRIPT);
  const lines = md.split("\n");
  const at = lines.findIndex((l) => l.startsWith("1. "));
  assert.match(lines[at], /^1\. 6ce249 -- 2 times x 2 people = 4$/);
  assert.equal(lines[at + 1], '   npm error missing script: "build"');
  assert.match(lines[at + 2], /^   fix \(medium, ankit\): Add a build script to package\.json$/);
  assert.match(lines[at + 3], /^   Fix this at the source: add the script to package\.json/);
  // Exactly one recommendation per error.
  assert.equal([...md.matchAll(/Fix this at the source:/g)].length, 1);
});

test("an error whose fix has not synced yet still gets a recommendation", () => {
  // Votes for a fix whose solved line is not in this notebook: no fix text to
  // quote, but the error is still worth acting on.
  const events = [
    { type: "confirmed", fingerprint: "e73c44", fixId: "nope", author: "ankit-aggarwal", ts: daysAgo(3) },
    { type: "confirmed", fingerprint: "e73c44", fixId: "nope", author: "louisa-tambunting", ts: daysAgo(2) },
  ];
  const md = report(events);
  assert.match(md, /e73c44 -- 2 times x 2 people = 4/);
  assert.match(md, /fix: none saved yet/);
  assert.match(md, /\(no summary saved for this error\)/);
  assert.match(md, /Fix this at the source: document this in the README setup steps/);
});

test("notebook text cannot break the report's shape", () => {
  const events = error({
    id: "bb2222", type: "TypeError",
    summary: "café — typeerror\nnewline",
    fix: "step one\nstep two\u001b[31mred\u001b[0m\ttab",
    people: ["louisa-tambunting"],
  });
  const md = report(events);
  // eslint-disable-next-line no-control-regex -- asserting the absence of them
  assert.doesNotMatch(md, /[^\x0a\x20-\x7e]/, "printable ASCII and newlines only");
  assert.equal([...md.matchAll(/Fix this at the source:/g)].length, 1, "a smuggled newline cannot forge an entry");
});

// --- empty -----------------------------------------------------------------

test("a notebook with nothing recurring says so", () => {
  assert.match(report(SOLO), /Nothing recurring yet: no error here has hit two or more people/);
  assert.match(report([]), /Nothing recurring yet/);
  assert.match(report(null), /Nothing recurring yet/);
  assert.ok(!report([]).includes("Fix this at the source"));
});

// --- the command -----------------------------------------------------------

test("the report goes to stdout and exits 0", () => {
  const ui = sink();
  const code = runSuggest({ ui: createDisplay(ui.out, ui.err), events: [...MISSING_SCRIPT, ...SOLO], now: NOW });
  assert.equal(code, 0);
  assert.match(ui.stdout(), /errorbook suggest/);
  assert.match(ui.stdout(), /Fix this at the source: add the script to package\.json/);
  assert.equal(ui.stderr(), "", "a report is not an error");
});

test("suggest writes nothing", () => {
  const before = fs.readdirSync(dir);
  const ui = sink();
  runSuggest({ ui: createDisplay(ui.out, ui.err), events: MISSING_SCRIPT, now: NOW });
  assert.deepEqual(fs.readdirSync(dir), before, "read-only: the notebook folder is untouched");
});

// --- the dispatch ----------------------------------------------------------

const quiet = { interactive: false, async ask() { return ""; }, async yes() { return false; }, close() {} };

test("errorbook suggest runs end to end over the real notebook", async () => {
  const saved = append({
    type: "solved", fingerprint: "6ce249", fix: "Add a build script to package.json",
    author: "ankit-aggarwal", summary: 'npm error missing script: "build"',
    loose: { lang: "npm", errorType: "missing-script", file: null }, timeToSolve: 1200,
  });
  append({ type: "confirmed", fingerprint: "6ce249", fixId: saved.fixId, author: "louisa-tambunting" });

  const ui = sink();
  const code = await runCli(["suggest"], { ui: createDisplay(ui.out, ui.err), prompts: quiet });
  assert.equal(code, 0);
  assert.match(ui.stdout(), /6ce249 -- 2 times x 2 people = 4/);
  assert.match(ui.stdout(), /Fix this at the source: add the script to package\.json/);
});

test("the usage text lists suggest", async () => {
  const ui = sink();
  await runCli([], { ui: createDisplay(ui.out, ui.err), prompts: quiet });
  assert.match(ui.stderr(), /errorbook suggest/);
});
