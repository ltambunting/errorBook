// Covers `errorbook lookup`: asking the notebook about an error you are
// holding, rather than one a command just produced.
//
// The fingerprints here are not written by hand -- the fixtures in samples/ are
// fingerprinted by the same code the command uses, so these cases exercise the
// real ids. samples/npm-missing-script-ankit.txt (6ce249) and
// samples/npm-missing-script-doesnotexist-ankit.txt (e73c44) are two different
// errors that share a loose description, which is what makes a loose-match case
// possible without inventing one.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { runCli } from "../src/cli/cli.js";
import { createDisplay } from "../src/cli/display.js";
import { append } from "../src/memory/index.js";
import { runLookup, parseArgs, readInput } from "../src/lookup/index.js";
import { contextFromFailure } from "../src/explainer/context.js";

// Nothing here may depend on the caller's shell. A developer with
// ERRORBOOK_DIR exported for their own notebook, or ERRORBOOK_AUTHOR_NAME set
// for a demo, would otherwise have this suite read their real notebook and get
// answers that say nothing about the code. Cleared first, pointed at a temp
// folder, restored at the end.
const INHERITED = ["ERRORBOOK_DIR", "ERRORBOOK_AUTHOR", "ERRORBOOK_AUTHOR_NAME", "ERRORBOOK_AUTHOR_EMAIL"];
const callerEnv = Object.fromEntries(INHERITED.map((key) => [key, process.env[key]]));
for (const key of INHERITED) delete process.env[key];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "errorbook-lookup-"));
process.env.ERRORBOOK_DIR = dir;

after(() => {
  for (const key of INHERITED) {
    if (callerEnv[key] === undefined) delete process.env[key];
    else process.env[key] = callerEnv[key];
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const name of fs.readdirSync(dir)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
});

function sink() {
  const out = [], err = [];
  const stream = (bucket) => new Writable({ write(c, e, cb) { bucket.push(c.toString()); cb(); } });
  return { out: stream(out), err: stream(err), stdout: () => out.join(""), stderr: () => err.join("") };
}

const NOW = Date.parse("2026-10-18T09:00:00Z");
const DAY = 86400000;
const daysAgo = (d) => new Date(NOW - d * DAY).toISOString();

const sample = (name) => fs.readFileSync(new URL(`../samples/${name}`, import.meta.url), "utf8");
const NPM_BUILD = sample("npm-missing-script-ankit.txt");               // 6ce249
const NPM_OTHER = sample("npm-missing-script-doesnotexist-ankit.txt");   // e73c44, loose-matches 6ce249
const NODE_MISSING = sample("node-module-not-found-ankit.txt");          // fb4768

// Runs the command over the temp notebook and reports what it printed.
function lookup(argv, over = {}) {
  const ui = sink();
  const code = runLookup({ ui: createDisplay(ui.out, ui.err), argv, now: NOW, ...over });
  return { code, stdout: ui.stdout(), stderr: ui.stderr() };
}

// The notebook the questions are asked against: one fix another teammate has
// confirmed, plus a second fix for the same error so there is an alternative.
function seed() {
  const first = append({
    type: "solved",
    fingerprint: "6ce249",
    fix: "Add a build script to package.json",
    author: "ankit-aggarwal",
    summary: 'npm error missing script: "build"',
    loose: { lang: "npm", errorType: "missing-script", file: null },
    ts: daysAgo(4),
  });
  const second = append({
    type: "solved",
    fingerprint: "6ce249",
    fix: "Reinstall node_modules",
    author: "louisa-tambunting",
    loose: { lang: "npm", errorType: "missing-script", file: null },
    ts: daysAgo(3),
  });
  append({ type: "confirmed", fingerprint: "6ce249", fixId: first.fixId, author: "louisa-tambunting", ts: daysAgo(2) });
  return { first, second };
}

// --- the arguments and the input ------------------------------------------

test("parseArgs takes --json anywhere and keeps the rest as error text", () => {
  assert.deepEqual(parseArgs([]), { json: false, text: "" });
  assert.deepEqual(parseArgs(["--json"]), { json: true, text: "" });
  assert.deepEqual(parseArgs(["npm", "error", "missing", "script"]), { json: false, text: "npm error missing script" });
  assert.deepEqual(parseArgs(["--json", "TypeError:", "x"]), { json: true, text: "TypeError: x" });
  assert.deepEqual(parseArgs(["--", "--json", "is", "the", "error"]), { json: false, text: "--json is the error" });
});

test("arguments win over stdin, and a terminal is never read from", () => {
  const piped = { isTTY: false };
  assert.equal(readInput({ text: "from args", stdin: piped, fs: { readFileSync: () => "from stdin" } }), "from args");
  assert.equal(readInput({ text: "", stdin: piped, fs: { readFileSync: () => "from stdin" } }), "from stdin");
  // A tty would block on a paste that never ends.
  assert.equal(readInput({ text: "", stdin: { isTTY: true }, fs: { readFileSync: () => "never" } }), "");
});

test("no error text at all is an error on stderr, not an empty answer", () => {
  const r = lookup([], { stdin: { isTTY: true } });
  assert.equal(r.code, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /no error text\. Pipe it in, or pass it as arguments/);
});

test("text with nothing fingerprintable in it is reported the same way", () => {
  const r = lookup([], { text: "   \n \t \n" });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no error text/);
});

// --- an exact hit ---------------------------------------------------------

test("an exact hit prints the fix with its author, age, confidence and confirmations", () => {
  seed();
  const r = lookup([], { text: NPM_BUILD });

  assert.equal(r.code, 0);
  assert.match(r.stdout, /ERRORBOOK 6ce249/, "the pasted text fingerprints to the id the capture would have produced");
  assert.match(r.stdout, /Known error/);
  assert.match(r.stdout, /1\. Add a build script to package\.json/);
  assert.match(r.stdout, /fixed by ankit - 4 days ago/, "author and age");
  assert.match(r.stdout, /confidence: medium - confirmed 1 - rejected 0/);
  assert.equal(r.stderr, "");
});

test("the alternatives are listed under the best fix", () => {
  seed();
  const r = lookup([], { text: NPM_BUILD });
  assert.match(r.stdout, /2\. Reinstall node_modules/);
  assert.match(r.stdout, /fixed by louisa - 3 days ago/);
  // Ranked, not in file order: the confirmed fix leads.
  assert.ok(r.stdout.indexOf("Add a build script") < r.stdout.indexOf("Reinstall node_modules"));
});

// --- a loose hit ----------------------------------------------------------

test("a loose hit says so before the fix, and still exits 0", () => {
  seed();
  // A different error (e73c44) that shares the loose description of 6ce249.
  const r = lookup([], { text: NPM_OTHER });

  assert.equal(r.code, 0);
  assert.match(r.stdout, /ERRORBOOK e73c44/, "the id is the pasted error's own, not the one that matched");
  assert.match(r.stdout, /This is a similar error, not an exact match/);
  assert.match(r.stdout, /Similar error/);
  assert.match(r.stdout, /Add a build script to package\.json/);
  // The caveat comes before the fix, so it is read first.
  assert.ok(r.stdout.indexOf("not an exact match") < r.stdout.indexOf("Add a build script"));
});

// --- a miss ---------------------------------------------------------------

test("a miss prints no known fix and exits 1", () => {
  seed();
  const r = lookup([], { text: NODE_MISSING });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /ERRORBOOK fb4768/);
  assert.match(r.stdout, /no known fix/);
  assert.ok(!r.stdout.includes("Known error"), "nothing is claimed as a match");
});

test("an empty notebook is a miss rather than a crash", () => {
  const r = lookup([], { text: NPM_BUILD });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /no known fix/);
});

test("an error with votes but no saved fix is a miss", () => {
  // A confirmation pulled from a teammate whose solved line has not synced yet.
  append({ type: "confirmed", fingerprint: "6ce249", fixId: "deadbeef", author: "louisa-tambunting", ts: daysAgo(1) });
  const r = lookup([], { text: NPM_BUILD });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /no known fix/);
});

// --- --json ---------------------------------------------------------------

test("--json prints kind, fix and alternatives, and parses", () => {
  const { first, second } = seed();
  const r = lookup(["--json"], { text: NPM_BUILD });
  assert.equal(r.code, 0);

  const data = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(data), ["kind", "errorId", "summary", "fix", "alternatives"]);
  assert.equal(data.kind, "exact");
  assert.equal(data.errorId, "6ce249");
  assert.equal(data.fix.fix, "Add a build script to package.json");
  assert.equal(data.fix.fixId, first.fixId);
  assert.equal(data.fix.author, "ankit-aggarwal", "the stored slug, not the display name");
  assert.equal(data.fix.age, "4 days ago");
  assert.equal(data.fix.confidence, "medium");
  assert.equal(data.fix.confirmations, 1);
  assert.equal(data.fix.rejections, 0);
  assert.equal(data.fix.returned, false);
  assert.equal(data.alternatives.length, 1);
  assert.equal(data.alternatives[0].fixId, second.fixId);
});

test("--json on a miss is still valid JSON, with a null fix and exit 1", () => {
  seed();
  const r = lookup(["--json"], { text: NODE_MISSING });
  assert.equal(r.code, 1);
  const data = JSON.parse(r.stdout);
  assert.equal(data.kind, "none");
  assert.equal(data.fix, null);
  assert.deepEqual(data.alternatives, []);
  assert.equal(r.stderr, "", "a miss is an answer, so stdout stays parseable and stderr stays clean");
});

test("--json reports a loose match as loose", () => {
  seed();
  const data = JSON.parse(lookup(["--json"], { text: NPM_OTHER }).stdout);
  assert.equal(data.kind, "loose");
  assert.equal(data.errorId, "e73c44");
  assert.equal(data.fix.fingerprint, "6ce249", "the fix belongs to the error that matched");
});

test("--json text is ASCII only with control characters stripped", () => {
  append({
    type: "solved",
    fingerprint: "6ce249",
    fix: "run café — build\nthen \u001b[31mnpm run build\u001b[0m\tagain",
    author: "ankit-aggarwal",
    loose: { lang: "npm", errorType: "missing-script", file: null },
    ts: daysAgo(1),
  });
  const r = lookup(["--json"], { text: NPM_BUILD });
  const data = JSON.parse(r.stdout);
  // eslint-disable-next-line no-control-regex -- asserting the absence of them
  assert.doesNotMatch(r.stdout, /[^\x0a\x20-\x7e]/, "the whole document is printable ASCII");
  assert.ok(!data.fix.fix.includes("\n"), "no newline survives inside a string");
  assert.equal(data.fix.fix, "run caf build then [31mnpm run build [0m again");
});

// --- read-only ------------------------------------------------------------

test("the notebook is byte-identical after a lookup", () => {
  seed();
  const snapshot = fs.readdirSync(dir).sort().map((name) => {
    const file = path.join(dir, name);
    return { name, bytes: fs.readFileSync(file), mtimeMs: fs.statSync(file).mtimeMs };
  });

  assert.equal(lookup([], { text: NPM_BUILD }).code, 0, "an exact hit");
  assert.equal(lookup([], { text: NPM_OTHER }).code, 0, "a loose hit");
  assert.equal(lookup([], { text: NODE_MISSING }).code, 1, "and a miss");
  assert.equal(lookup(["--json"], { text: NPM_BUILD }).code, 0);

  const after_ = fs.readdirSync(dir).sort().map((name) => {
    const file = path.join(dir, name);
    return { name, bytes: fs.readFileSync(file), mtimeMs: fs.statSync(file).mtimeMs };
  });
  assert.deepEqual(after_, snapshot, "no line appended, no file added, nothing touched");
});

// --- the dispatch ---------------------------------------------------------

const quiet = { interactive: false, async ask() { return ""; }, async yes() { return false; }, close() {} };

test("errorbook lookup passes its arguments through and returns the exit code", async () => {
  const calls = [];
  const ui = sink();
  const code = await runCli(["lookup", "--json", "some", "error"], {
    ui: createDisplay(ui.out, ui.err),
    prompts: quiet,
    lookup: (deps) => { calls.push(deps); return 1; },
  });
  assert.equal(code, 1);
  assert.deepEqual(calls[0].argv, ["--json", "some", "error"]);
  assert.ok(calls[0].ui, "the lookup is handed the cli's display");
});

test("errorbook lookup never calls the AI", async () => {
  seed();
  const ui = sink();
  const explainer = { calls: 0, async explain() { this.calls++; return { status: "ok" }; } };
  // A miss is the case that would reach for an explanation in the run path.
  const code = await runCli(["lookup", ...NODE_MISSING.split(/\s+/)], {
    ui: createDisplay(ui.out, ui.err),
    prompts: quiet,
    explainer,
  });
  assert.equal(code, 1);
  assert.match(ui.stdout(), /no known fix/);
  assert.equal(explainer.calls, 0, "no AI call on a miss, which is the whole point of a read-only lookup");
});

test("errorbook lookup runs end to end over the real notebook", async () => {
  // A single-line error, so the words the shell hands over rejoin into exactly
  // the text that was fingerprinted.
  const text = "Error: Cannot find module 'express'";
  const id = contextFromFailure({ stderr: text }).errorId;
  append({ type: "solved", fingerprint: id, fix: "npm i express", author: "ankit-aggarwal", ts: daysAgo(1) });

  const ui = sink();
  const code = await runCli(["lookup", "--json", ...text.split(" ")], {
    ui: createDisplay(ui.out, ui.err),
    prompts: quiet,
  });
  assert.equal(code, 0);
  const data = JSON.parse(ui.stdout());
  assert.equal(data.kind, "exact");
  assert.equal(data.errorId, id);
  assert.equal(data.fix.fix, "npm i express");
});

test("a multi-line error passed as arguments loses its line breaks, so it lands as a loose match", () => {
  // Worth pinning down rather than discovering later: the shell splits the
  // argument list, so the text rejoins on single spaces and fingerprints as a
  // different error. The loose description survives, which is what saves the
  // answer -- and is why a pipe is the better way to hand over a stack trace.
  seed();
  const asArgs = lookup(NPM_BUILD.split(/\s+/));
  assert.equal(asArgs.code, 0);
  assert.match(asArgs.stdout, /This is a similar error, not an exact match/);
  assert.match(asArgs.stdout, /Add a build script to package\.json/);
  // Piped, the same text is an exact hit.
  assert.match(lookup([], { text: NPM_BUILD }).stdout, /Known error/);
});

test("the usage text lists lookup", async () => {
  const ui = sink();
  await runCli([], { ui: createDisplay(ui.out, ui.err), prompts: quiet });
  assert.match(ui.stderr(), /errorbook lookup \[--json\] \[error text\.\.\.\]/);
});
