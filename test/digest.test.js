// Covers `errorbook digest`: the markdown report built from the dashboard's
// own stats module.
//
// The point of most of these cases is that the digest states what summarise()
// states. So the expected numbers are not written out by hand -- they are read
// from summarise() in the test and then looked for in the markdown. A change to
// the maths moves both sides together; a digest that re-derives a number drifts
// from it and fails here.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { runCli } from "../src/cli/cli.js";
import { createDisplay } from "../src/cli/display.js";
import { append, loadAll } from "../src/memory/index.js";
import { digest, runDigest, parseArgs, withinWindow, loadStats } from "../src/digest/index.js";

// Nothing here may depend on the caller's shell. A developer with
// ERRORBOOK_DIR exported for their own notebook, or ERRORBOOK_AUTHOR_NAME set
// for a demo, would otherwise have this suite read and report on their real
// notebook. Cleared first, pointed at a temp folder, restored at the end.
const INHERITED = ["ERRORBOOK_DIR", "ERRORBOOK_AUTHOR", "ERRORBOOK_AUTHOR_NAME", "ERRORBOOK_AUTHOR_EMAIL"];
const callerEnv = Object.fromEntries(INHERITED.map((key) => [key, process.env[key]]));
for (const key of INHERITED) delete process.env[key];

const temps = [];
const tempDir = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
};
const dir = tempDir("errorbook-digest-");
process.env.ERRORBOOK_DIR = dir;

after(() => {
  for (const key of INHERITED) {
    if (callerEnv[key] === undefined) delete process.env[key];
    else process.env[key] = callerEnv[key];
  }
  for (const temp of temps) fs.rmSync(temp, { recursive: true, force: true });
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

// A notebook shaped like the demo seed: two people, one error with two
// competing fixes, one fix that worked and then stopped working, and one error
// old enough to fall outside a 7-day window.
function seed() {
  return [
    { type: "solved", fingerprint: "6ce249", fixId: "b1", fix: "Add a build script", author: "ankit-aggarwal", ts: daysAgo(5), timeToSolve: 1380, summary: 'npm error missing script: "build"', loose: { lang: "npm", errorType: "missing-script", file: null } },
    { type: "solved", fingerprint: "6ce249", fixId: "b2", fix: "Reinstall node_modules", author: "louisa-tambunting", ts: daysAgo(5, 2), timeToSolve: 2700 },
    { type: "confirmed", fingerprint: "6ce249", fixId: "b1", author: "louisa-tambunting", ts: daysAgo(4) },
    { type: "rejected", fingerprint: "6ce249", fixId: "b2", author: "ankit-aggarwal", ts: daysAgo(3) },
    { type: "rejected", fingerprint: "6ce249", fixId: "b2", author: "louisa-tambunting", ts: daysAgo(3, 1) },
    { type: "solved", fingerprint: "204e89", fixId: "c1", fix: "Guard the list", author: "ankit-aggarwal", ts: daysAgo(6), timeToSolve: 3300, summary: "typeerror: cannot read properties of undefined", loose: { lang: "node", errorType: "TypeError", file: "cart.js" } },
    { type: "confirmed", fingerprint: "204e89", fixId: "c1", author: "louisa-tambunting", ts: daysAgo(5) },
    { type: "returned", fingerprint: "204e89", fixId: "c1", author: "louisa-tambunting", ts: daysAgo(2) },
    // Outside a 7-day window, inside a 30-day one.
    { type: "solved", fingerprint: "20116d", fixId: "e1", fix: "npm i -D eslint-config-airbnb", author: "ankit-aggarwal", ts: daysAgo(20), timeToSolve: 420 },
  ];
}

const report = (events, over = {}) => digest(events, { now: NOW, ...over });

// --- the window ------------------------------------------------------------

test("the window keeps the last N days and drops what is older", () => {
  const week = withinWindow(seed(), { days: 7, now: NOW });
  assert.equal(week.length, 8, "the 20-day-old entry is out");
  assert.ok(!week.some((e) => e.fingerprint === "20116d"));
  assert.equal(withinWindow(seed(), { days: 30, now: NOW }).length, 9);
});

test("an event with no usable timestamp stays out of a dated window", () => {
  const events = [{ type: "solved", fingerprint: "6ce249", ts: undefined }, { type: "solved", fingerprint: "6ce249", ts: "not a date" }];
  assert.deepEqual(withinWindow(events, { now: NOW }), []);
});

// --- the numbers are summarise()'s numbers ---------------------------------

test("the headline states summarise()'s error count, people and hours", () => {
  const events = seed();
  const windowed = withinWindow(events, { days: 7, now: NOW });
  const expected = S.summarise(windowed, NOW, 7);
  const md = report(events);

  assert.match(md, new RegExp(`- Errors: ${expected.errors.length}\\b`));
  assert.match(md, new RegExp(`- People: ${expected.people.length}\\b`));
  assert.match(md, new RegExp(`- Hours lost: ${expected.totalHoursLost}\\b`));
  // Guard against the numbers being trivially equal by accident.
  assert.equal(expected.errors.length, 2);
  assert.equal(expected.people.length, 2);
  assert.ok(expected.totalHoursLost > 0);
});

test("the hit rate is summarise()'s, and is labelled as derived rather than measured", () => {
  const events = seed();
  const expected = S.summarise(withinWindow(events, { days: 7, now: NOW }), NOW, 7).hitRate;
  const md = report(events);
  assert.match(md, new RegExp(`${expected.percent}% -- ${expected.hits} of ${expected.total} encounters`));
  assert.match(md, /derived from the notebook, not measured/i);
});

test("the hit rate is measured, and said to be, once there are lookups", () => {
  // 1 hit, 1 loose and 2 misses inside the week: 2 of 4 is 50%, which the
  // derived method would have called 75%.
  const events = seed().concat([
    { type: "lookup", fingerprint: "6ce249", result: "hit", author: "louisa-tambunting", ts: daysAgo(4) },
    { type: "lookup", fingerprint: "204e89", result: "miss", author: "ankit-aggarwal", ts: daysAgo(3) },
    { type: "lookup", fingerprint: "e73c44", result: "loose", author: "ankit-aggarwal", ts: daysAgo(2) },
    { type: "lookup", fingerprint: "28b25a", result: "miss", author: "louisa-tambunting", ts: daysAgo(1) },
  ]);
  const expected = S.summarise(withinWindow(events, { days: 7, now: NOW }), NOW, 7).hitRate;
  assert.equal(expected.measured, true);
  assert.equal(expected.percent, 50);

  const md = report(events);
  assert.match(md, new RegExp(`${expected.percent}% -- ${expected.hits} of ${expected.total} lookups`));
  assert.match(md, /measured from lookups/i);
  assert.doesNotMatch(md, /derived from the notebook, not measured/i, "one method per number, one label");

  // The derived number for this same window is a different number, and must
  // not appear anywhere in the report.
  const derived = S.hitRate(withinWindow(events, { days: 7, now: NOW }));
  assert.notEqual(derived.percent, expected.percent);
  assert.doesNotMatch(md, new RegExp(`${derived.percent}% --`));
});

test("the headline counts no lookup as a person, an error or an hour", () => {
  const events = seed();
  const plain = report(events);
  const withLookups = report(events.concat([
    { type: "lookup", fingerprint: "ffffff", result: "miss", author: "mara", ts: daysAgo(1) },
  ]));
  const headline = (md) => md.slice(md.indexOf("## Headline"), md.indexOf("## Hit rate"));
  assert.equal(headline(withLookups), headline(plain), "mara looked something up; she did not lose an hour to it");
  assert.doesNotMatch(withLookups, /ffffff/, "a looked-up error is not a top error");
});

test("the top errors are summarise()'s order, with its score, counts and hours", () => {
  const events = seed();
  const expected = S.summarise(withinWindow(events, { days: 7, now: NOW }), NOW, 7).errors;
  const md = report(events);
  const listed = [...md.matchAll(/^\d+\. `([0-9a-f]+)`/gm)].map((m) => m[1]);
  assert.deepEqual(listed, expected.slice(0, 5).map((e) => e.fingerprint), "same errors, same order as the dashboard");
  for (const error of expected.slice(0, 5)) {
    assert.match(md, new RegExp(`\`${error.fingerprint}\` -- score ${error.score} \\(${error.occurrences} times?, ${error.peopleAffected} (?:person|people)\\), ${error.hoursLost} hours lost`));
  }
});

test("at most five errors are listed however many there are", () => {
  const many = [];
  for (let i = 0; i < 9; i++) {
    const id = `f${i}0000`;
    many.push({ type: "solved", fingerprint: id, fixId: `x${i}`, fix: "a fix", author: "ankit-aggarwal", ts: daysAgo(1), timeToSolve: 600 });
    many.push({ type: "confirmed", fingerprint: id, fixId: `x${i}`, author: "louisa-tambunting", ts: daysAgo(1, 1) });
  }
  const md = report(many);
  assert.equal([...md.matchAll(/^\d+\. `/gm)].length, 5);
  assert.match(md, /- Errors: 9/, "the headline still counts them all");
});

test("fixes that returned or failed are listed, and a clean window says so", () => {
  const md = report(seed());
  // c1 worked and then came back; b2 was rejected by two people.
  assert.match(md, /## Fixes that returned or failed/);
  assert.match(md, /`204e89` returned \(the error came back/);
  assert.match(md, /`6ce249` failed \(rejected by the team/);

  const clean = report([
    { type: "solved", fingerprint: "6ce249", fixId: "b1", fix: "Add a build script", author: "ankit-aggarwal", ts: daysAgo(1), timeToSolve: 600 },
    { type: "confirmed", fingerprint: "6ce249", fixId: "b1", author: "louisa-tambunting", ts: daysAgo(1, 1) },
  ]);
  assert.match(clean, /None: no fix in this window was reported failed/);
});

test("who solved what lists each author's errors once", () => {
  const md = report(seed());
  assert.match(md, /- ankit: 2 errors \(`6ce249`, `204e89`\)|- ankit: 2 errors \(`204e89`, `6ce249`\)/);
  assert.match(md, /- louisa: 1 error \(`6ce249`\)/);
});

// --- --days ----------------------------------------------------------------

test("--days narrows the window, and every section narrows with it", () => {
  const events = seed();
  const week = report(events, { days: 7 });
  const month = report(events, { days: 30 });

  assert.match(week, /Last 7 days, to 2026-10-18/);
  assert.match(month, /Last 30 days, to 2026-10-18/);
  // The 20-day-old error is in one report and not the other.
  assert.ok(!week.includes("20116d"), "an entry outside the window is not reported");
  assert.ok(month.includes("20116d"));
  assert.match(week, /- Errors: 2/);
  assert.match(month, /- Errors: 3/);

  const expected = S.summarise(withinWindow(events, { days: 30, now: NOW }), NOW, 30);
  assert.match(month, new RegExp(`- Hours lost: ${expected.totalHoursLost}\\b`));
  assert.match(month, new RegExp(`- People: ${expected.people.length}\\b`));
});

test("a window with nothing in it gets the short nothing-yet message", () => {
  const md = report(seed(), { days: 1 });
  assert.match(md, /^# errorbook digest/);
  assert.match(md, /Nothing yet: no notebook entries in this window/);
  assert.ok(!md.includes("## Headline"), "no empty sections over an empty window");
  assert.ok(md.split("\n").length < 8, "and it stays short");
});

test("an empty notebook gets the same message rather than zeroes", () => {
  assert.match(digest([], { now: NOW }), /Nothing yet/);
  assert.match(digest(null, { now: NOW }), /Nothing yet/);
});

// --- the text the notebook supplies ----------------------------------------

test("control characters and non-ASCII from the notebook never reach the report", () => {
  const md = report([
    { type: "solved", fingerprint: "6ce249", fixId: "b1", ts: daysAgo(1), timeToSolve: 600,
      summary: "café — typeerror\nnewline",
      fix: "line one\nline two\u001b[31mred\u001b[0m\ttab", author: "ankit-aggarwal" },
    { type: "confirmed", fingerprint: "6ce249", fixId: "b1", author: "louisa-tambunting", ts: daysAgo(1, 1) },
  ]);
  // eslint-disable-next-line no-control-regex -- asserting the absence of them
  assert.doesNotMatch(md, /[^\x0a\x20-\x7e]/, "the markdown is printable ASCII and newlines");
  // The fix was folded onto one line, so it cannot forge a list item.
  // Each stripped character becomes a space, so the escape introducer is gone
  // and only its harmless literal tail is left.
  assert.match(md, /- fix \(medium, ankit\): line one line two \[31mred \[0m tab$/m);
});

test("fix text is scrubbed, so a credential in an old line is masked in the report", () => {
  const md = report([
    { type: "solved", fingerprint: "6ce249", fixId: "b1", ts: daysAgo(1), timeToSolve: 600,
      summary: "fatal: authentication failed",
      fix: "git remote set-url origin https://ankit:ghp_0123456789abcdefghijABCDEFGHIJ0123@github.com/x/y",
      author: "ankit-aggarwal" },
    { type: "confirmed", fingerprint: "6ce249", fixId: "b1", author: "louisa-tambunting", ts: daysAgo(1, 1) },
  ]);
  assert.ok(!md.includes("ghp_0123456789abcdefghijABCDEFGHIJ0123"), "the token is not in the digest");
  assert.match(md, /\[redacted\]/);
});

test("long text is clipped so one fix cannot be the whole report", () => {
  const md = report([
    { type: "solved", fingerprint: "6ce249", fixId: "b1", ts: daysAgo(1), timeToSolve: 600,
      fix: "check the build step. ".repeat(40), author: "ankit-aggarwal" },
    { type: "confirmed", fingerprint: "6ce249", fixId: "b1", author: "louisa-tambunting", ts: daysAgo(1, 1) },
  ]);
  const fixLine = md.split("\n").find((l) => l.includes("- fix ("));
  assert.ok(fixLine.length < 200);
  assert.match(fixLine, /\.\.\.$/);
});

// --- the arguments ---------------------------------------------------------

test("parseArgs defaults to 7 days and stdout, and rejects nonsense", () => {
  assert.deepEqual(parseArgs([]), { days: 7, out: null });
  assert.deepEqual(parseArgs(["--days", "30"]), { days: 30, out: null });
  assert.deepEqual(parseArgs(["--out", "x.md", "--days", "1"]), { days: 1, out: "x.md" });
  assert.throws(() => parseArgs(["--days", "0"]), /whole number/);
  assert.throws(() => parseArgs(["--days", "abc"]), /whole number/);
  assert.throws(() => parseArgs(["--days"]), /whole number/);
  assert.throws(() => parseArgs(["--out"]), /file path/);
  assert.throws(() => parseArgs(["--weekly"]), /Unknown option/);
});

test("a bad option is an error on stderr and exit 1, with nothing on stdout", () => {
  const ui = sink();
  const code = runDigest({ ui: createDisplay(ui.out, ui.err), argv: ["--days", "-3"], events: seed(), now: NOW });
  assert.equal(code, 1);
  assert.equal(ui.stdout(), "");
  assert.match(ui.stderr(), /errorbook digest: --days wants a whole number/);
});

// --- the command -----------------------------------------------------------

test("the markdown goes to stdout by default", () => {
  const ui = sink();
  const code = runDigest({ ui: createDisplay(ui.out, ui.err), argv: [], events: seed(), now: NOW });
  assert.equal(code, 0);
  assert.match(ui.stdout(), /^\n?# errorbook digest/);
  assert.match(ui.stdout(), /## Hit rate/);
  assert.equal(ui.stderr(), "");
});

test("--out writes the file and keeps the markdown off stdout", () => {
  const file = path.join(tempDir("errorbook-digest-out-"), "digest.md");
  const ui = sink();
  const code = runDigest({ ui: createDisplay(ui.out, ui.err), argv: ["--out", file, "--days", "30"], events: seed(), now: NOW });
  assert.equal(code, 0);

  const written = fs.readFileSync(file, "utf8");
  assert.match(written, /^# errorbook digest/);
  assert.match(written, /Last 30 days/);
  assert.match(written, /## Who solved what/);
  assert.ok(written.endsWith("\n"), "the file ends with exactly one newline");
  assert.ok(!written.endsWith("\n\n"));
  assert.equal(written, `${report(seed(), { days: 30 }).replace(/\n*$/, "")}\n`, "the file holds what stdout would have");

  assert.ok(!ui.stdout().includes("## Hit rate"), "the report itself is not also printed");
  assert.match(ui.stdout(), new RegExp(`Wrote ${file.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}`));
});

test("a file that cannot be written is an error, not a silent success", () => {
  const ui = sink();
  const code = runDigest({
    ui: createDisplay(ui.out, ui.err),
    argv: ["--out", path.join(dir, "nope", "digest.md")],
    events: seed(),
    now: NOW,
  });
  assert.equal(code, 1);
  assert.match(ui.stderr(), /cannot write/);
});

test("the digest reads nothing and writes nothing when it only prints", () => {
  const before = fs.readdirSync(dir);
  const ui = sink();
  runDigest({ ui: createDisplay(ui.out, ui.err), argv: [], events: seed(), now: NOW });
  assert.deepEqual(fs.readdirSync(dir), before, "read-only: the notebook folder is untouched");
});

// --- the dispatch ----------------------------------------------------------

const quiet = { interactive: false, async ask() { return ""; }, async yes() { return false; }, close() {} };

test("errorbook digest passes its flags through and returns the exit code", async () => {
  const calls = [];
  const ui = sink();
  const code = await runCli(["digest", "--days", "30"], {
    ui: createDisplay(ui.out, ui.err),
    prompts: quiet,
    digest: (deps) => { calls.push(deps); return 0; },
  });
  assert.equal(code, 0);
  assert.deepEqual(calls[0].argv, ["--days", "30"]);
  assert.ok(calls[0].ui, "the digest is handed the cli's display");
});

test("errorbook digest runs end to end over the real notebook", async () => {
  // The one case that goes through memory.loadAll() against ERRORBOOK_DIR.
  append({ type: "solved", fingerprint: "6ce249", fix: "Add a build script to package.json", author: "ankit-aggarwal", summary: 'npm error missing script: "build"', timeToSolve: 1200 });
  append({ type: "confirmed", fingerprint: "6ce249", fixId: loadAll().find((e) => e.type === "solved").fixId, author: "louisa-tambunting" });

  const ui = sink();
  const code = await runCli(["digest"], { ui: createDisplay(ui.out, ui.err), prompts: quiet });
  assert.equal(code, 0);
  const md = ui.stdout();
  assert.match(md, /# errorbook digest/);
  assert.match(md, /`6ce249`/);
  assert.match(md, /Add a build script to package\.json/);
  assert.match(md, /- ankit: 1 error/);
});

test("the usage text lists digest", async () => {
  const ui = sink();
  await runCli([], { ui: createDisplay(ui.out, ui.err), prompts: quiet });
  assert.match(ui.stderr(), /errorbook digest \[--days N\] \[--out FILE\]/);
});
