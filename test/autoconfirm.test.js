// Auto-confirm: the vote nobody had to type.
//
// A developer is shown a known fix, says nothing, tries it, and runs the same
// command again. If it passes, that silence is worth a confirmation; if it
// fails, it is worth nothing. These cases pin down both, plus every case where
// the notebook must stay untouched -- your own fix, a second vote from the same
// person, a similar-but-not-equal error, an explicit answer, a stale entry, a
// corrupt file.
//
// Driven through runCli with a stubbed capture, like test/cli.test.js: real
// display, real notebook, real fingerprints.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { runCli } from "../src/cli/cli.js";
import { createDisplay } from "../src/cli/display.js";
import * as memory from "../src/memory/index.js";

// The caller's own notebook and demo author must not leak in, or these tests
// cast votes in somebody's real data. Cleared once, restored at the end.
const INHERITED = ["ERRORBOOK_DIR", "ERRORBOOK_AUTHOR", "ERRORBOOK_AUTHOR_NAME", "ERRORBOOK_AUTHOR_EMAIL"];
const callerEnv = Object.fromEntries(INHERITED.map((key) => [key, process.env[key]]));
for (const key of INHERITED) delete process.env[key];
after(() => {
  for (const key of INHERITED) {
    if (callerEnv[key] === undefined) delete process.env[key];
    else process.env[key] = callerEnv[key];
  }
});

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "eb-auto-"));
  process.env.ERRORBOOK_DIR = dir;
  process.env.ERRORBOOK_AUTHOR = "ankit";
});

// --- harness ---------------------------------------------------------------

function sink() {
  const out = [], err = [];
  const stream = (bucket) => new Writable({ write(c, e, cb) { bucket.push(c.toString()); cb(); } });
  return { out: stream(out), err: stream(err), stdout: () => out.join(""), stderr: () => err.join("") };
}

function scripted(...answers) {
  const asked = [];
  return {
    interactive: true, asked, closed: false,
    async ask(text) { asked.push(text); return String(answers.shift() ?? "").trim(); },
    async yes(text) { asked.push(text); return /^(y|yes)$/i.test(String(answers.shift() ?? "").trim()); },
    close() { this.closed = true; },
  };
}

const sample = (name) => fs.readFileSync(new URL(`../samples/${name}`, import.meta.url), "utf8");
const NPM_BUILD = sample("npm-missing-script-ankit.txt");              // 6ce249
const NPM_OTHER = sample("npm-missing-script-doesnotexist-ankit.txt"); // e73c44

// Stands in for capture: one failure, then the command's exit code.
const failsWith = (stderr, exitCode = 1) => async (argv, { onFailure }) => {
  await onFailure({ command: argv.join(" "), argv, stderr, exitCode, cwd: "/project", durationMs: 12 });
  return exitCode;
};
// The same stand-in for a command that works: onFailure is never called.
const succeeds = () => async () => 0;

async function run(args, over = {}) {
  const ui = over.sink ?? sink();
  const prompts = over.prompts ?? scripted();
  const code = await runCli(args, {
    ui: createDisplay(ui.out, ui.err),
    prompts,
    explainer: { async explain() { return { status: "unavailable", reason: "offline", message: "no AI here" }; } },
    capture: over.capture ?? failsWith(NPM_BUILD),
    shouldInterrupt: () => false,
  });
  return { code, prompts, stdout: ui.stdout(), stderr: ui.stderr() };
}

const notebook = () => fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"))
  .flatMap((f) => fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean).map(JSON.parse));
const confirmations = () => notebook().filter((e) => e.type === "confirmed");

const pendingFile = () => path.join(dir, "local", "pending.json");
const pendingStore = () => { try { return JSON.parse(fs.readFileSync(pendingFile(), "utf8")); } catch { return {}; } };
const pendingFor = (command = "npm run build") => pendingStore()[command] ?? null;

// ankit saves the fix; from here on the runs belong to louis, who is allowed to
// confirm it. Returns the fixId the notebook gave the fix.
async function seedAnkitsFix(fix = "Add a build script to package.json") {
  await run(["run", "npm", "run", "build"], { prompts: scripted("y", fix) });
  process.env.ERRORBOOK_AUTHOR = "louis";
  return notebook().find((e) => e.type === "solved").fixId;
}

// --- a pending entry is created only by an unanswered exact match -----------

test("an exact match the developer says nothing about becomes a pending entry", async () => {
  const fixId = await seedAnkitsFix();
  const r = await run(["run", "npm", "run", "build"], { prompts: scripted("") });

  assert.equal(r.code, 1);
  assert.match(r.stdout, /Known error - found in [0-9]+ms/);
  assert.deepEqual(pendingFor(), {
    fingerprint: "6ce249", fixId, command: "npm run build", author: "louis", ts: pendingFor().ts,
  });
  assert.equal(Object.keys(pendingStore()).length, 1, "one entry, for the command that was run");
  assert.equal(confirmations().length, 0, "nothing is recorded yet: the fix is only pending");
});

test("the pending entry holds no error text and no fix text", async () => {
  await seedAnkitsFix("Add a build script to package.json");
  await run(["run", "npm", "run", "build"], { prompts: scripted("") });

  const entry = pendingFor();
  assert.deepEqual(Object.keys(entry).sort(), ["author", "command", "fingerprint", "fixId", "ts"]);
  const text = JSON.stringify(entry);
  for (const leak of ["Missing script", "package.json", "/project", "add a build"]) {
    assert.doesNotMatch(text, new RegExp(leak, "i"), `pending.json leaked ${leak}`);
  }
});

test("a similar error creates nothing: its fix belongs to another error", async () => {
  await seedAnkitsFix();
  const r = await run(["run", "npm", "run", "doesnotexist"], {
    capture: failsWith(NPM_OTHER), prompts: scripted(""),
  });
  assert.match(r.stdout, /Similar error - found in [0-9]+ms/);
  assert.deepEqual(pendingStore(), {}, "a loose match is never auto-confirmed");
});

test("an unknown error creates nothing", async () => {
  const r = await run(["run", "npm", "run", "build"], { prompts: scripted("n") });
  assert.match(r.stdout, /not in the notebook yet/);
  assert.deepEqual(pendingStore(), {});
});

for (const [answer, type] of [["y", "confirmed"], ["n", "rejected"], ["r", "returned"]]) {
  test(`answering ${answer} records ${type} by hand and creates no pending entry`, async () => {
    await seedAnkitsFix();
    await run(["run", "npm", "run", "build"], { prompts: scripted(answer) });

    assert.equal(notebook().filter((e) => e.type === type).length, 1, "the explicit answer is what got recorded");
    assert.deepEqual(pendingStore(), {}, "an explicit answer wins: there is nothing left to infer");
  });
}

test("you never auto-confirm your own fix", async () => {
  await run(["run", "npm", "run", "build"], { prompts: scripted("y", "Add a build script to package.json") });
  // Still ankit: the fix is hers, so her own passing run proves nothing.
  const r = await run(["run", "npm", "run", "build"], { prompts: scripted("") });
  assert.match(r.stdout, /Known error/);
  assert.deepEqual(pendingStore(), {}, "no entry is created at all");

  const s = await run(["run", "npm", "run", "build"], { capture: succeeds() });
  assert.equal(s.code, 0);
  assert.equal(confirmations().length, 0);
  assert.equal(s.stdout, "", "and nothing is printed");
});

// --- the later run settles it ----------------------------------------------

test("the same command passing inside the window records the confirmation", async () => {
  const fixId = await seedAnkitsFix();
  await run(["run", "npm", "run", "build"], { prompts: scripted("") });

  const r = await run(["run", "npm", "run", "build"], { capture: succeeds() });

  assert.equal(r.code, 0, "the exit code is the command's own");
  assert.equal(r.stdout, "Recorded: the fix for 6ce249 appears to have worked.\n", "exactly one line, and nothing else");
  assert.equal(r.stderr, "");

  const votes = confirmations();
  assert.equal(votes.length, 1);
  assert.equal(votes[0].author, "louis");
  assert.equal(votes[0].fingerprint, "6ce249");
  assert.equal(votes[0].fixId, fixId);
  assert.equal(pendingFor(), null, "the entry is consumed");
});

test("the auto-confirmation raises the fix's confidence like any other vote", async () => {
  await seedAnkitsFix();
  const before = memory.lookup("6ce249");
  assert.equal(before.fix.confidence, "unproven");
  assert.equal(before.fix.confirmations, 0);

  await run(["run", "npm", "run", "build"], { prompts: scripted("") });
  await run(["run", "npm", "run", "build"], { capture: succeeds() });

  const after = memory.lookup("6ce249");
  assert.equal(after.fix.confirmations, 1);
  assert.equal(after.fix.rejections, 0);
  assert.equal(after.fix.confidence, "medium");
});

test("the same command failing again records nothing and drops the entry", async () => {
  await seedAnkitsFix();
  await run(["run", "npm", "run", "build"], { prompts: scripted("") });
  const first = pendingFor();
  assert.ok(first, "pending before the retry");

  const r = await run(["run", "npm", "run", "build"], { prompts: scripted("n"), capture: failsWith(NPM_BUILD, 1) });
  assert.equal(r.code, 1);
  assert.equal(confirmations().length, 0, "a fix that did not work is not confirmed");
  assert.doesNotMatch(r.stdout, /appears to have worked/);
  assert.deepEqual(pendingStore(), {}, "the entry it failed against is gone");
});

test("a silent failing retry leaves a fresh entry, not the old one", async () => {
  await seedAnkitsFix();
  await run(["run", "npm", "run", "build"], { prompts: scripted("") });
  const first = pendingFor().ts;

  await new Promise((r) => setTimeout(r, 5));
  await run(["run", "npm", "run", "build"], { prompts: scripted("") });
  assert.notEqual(pendingFor(), null);
  assert.ok(pendingFor().ts >= first, "the clock restarts with the run that was just shown the fix");
  assert.equal(confirmations().length, 0);
});

test("a pending entry older than 30 minutes is dropped silently", async () => {
  await seedAnkitsFix();
  await run(["run", "npm", "run", "build"], { prompts: scripted("") });

  const store = pendingStore();
  store["npm run build"].ts = new Date(Date.now() - 31 * 60 * 1000).toISOString();
  fs.writeFileSync(pendingFile(), JSON.stringify(store));

  const r = await run(["run", "npm", "run", "build"], { capture: succeeds() });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "", "silently: no line, because nothing was recorded");
  assert.equal(confirmations().length, 0);
  assert.equal(pendingFor(), null, "and the stale entry is gone");
});

test("an entry just inside the window still counts", async () => {
  await seedAnkitsFix();
  await run(["run", "npm", "run", "build"], { prompts: scripted("") });

  const store = pendingStore();
  store["npm run build"].ts = new Date(Date.now() - 29 * 60 * 1000).toISOString();
  fs.writeFileSync(pendingFile(), JSON.stringify(store));

  await run(["run", "npm", "run", "build"], { capture: succeeds() });
  assert.equal(confirmations().length, 1);
});

test("a different command passing settles nothing", async () => {
  await seedAnkitsFix();
  await run(["run", "npm", "run", "build"], { prompts: scripted("") });

  const r = await run(["run", "npm", "run", "test"], { capture: succeeds() });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "");
  assert.equal(confirmations().length, 0);
  assert.ok(pendingFor(), "the entry waits for its own command");
});

test("one auto-confirm per fix per person", async () => {
  await seedAnkitsFix();
  await run(["run", "npm", "run", "build"], { prompts: scripted("") });
  await run(["run", "npm", "run", "build"], { capture: succeeds() });
  assert.equal(confirmations().length, 1);

  // Same error, same person, all over again: no second entry, no second vote.
  const again = await run(["run", "npm", "run", "build"], { prompts: scripted("") });
  assert.match(again.stdout, /Known error/);
  assert.deepEqual(pendingStore(), {}, "louis has voted on this fix already");

  const r = await run(["run", "npm", "run", "build"], { capture: succeeds() });
  assert.equal(r.stdout, "");
  assert.equal(confirmations().length, 1, "still one");

  // A teammate who has not voted is unaffected.
  process.env.ERRORBOOK_AUTHOR = "mira";
  await run(["run", "npm", "run", "build"], { prompts: scripted("") });
  await run(["run", "npm", "run", "build"], { capture: succeeds() });
  assert.deepEqual(confirmations().map((e) => e.author).sort(), ["louis", "mira"]);
});

test("a fix already rejected by hand is not auto-confirmed later", async () => {
  await seedAnkitsFix();
  await run(["run", "npm", "run", "build"], { prompts: scripted("n") });
  const r = await run(["run", "npm", "run", "build"], { prompts: scripted("") });
  assert.match(r.stdout, /Known error/);
  assert.deepEqual(pendingStore(), {}, "the person has had their say on this fix");
});

// --- degraded inputs: never break the run ----------------------------------

test("a corrupt pending.json is ignored, and the run is unharmed", async () => {
  await seedAnkitsFix();
  fs.mkdirSync(path.join(dir, "local"), { recursive: true });
  fs.writeFileSync(pendingFile(), "{ this is not json");

  const s = await run(["run", "npm", "run", "build"], { capture: succeeds() });
  assert.equal(s.code, 0);
  assert.equal(s.stdout, "", "nothing to confirm, nothing said");
  assert.equal(confirmations().length, 0);

  // And the file heals: the next unanswered match writes a usable entry.
  const f = await run(["run", "npm", "run", "build"], { prompts: scripted("") });
  assert.equal(f.code, 1);
  assert.equal(pendingFor().fingerprint, "6ce249");
});

test("junk in place of an entry is ignored", async () => {
  await seedAnkitsFix();
  fs.mkdirSync(path.join(dir, "local"), { recursive: true });
  fs.writeFileSync(pendingFile(), JSON.stringify({ "npm run build": { fingerprint: "6ce249" } }));

  const r = await run(["run", "npm", "run", "build"], { capture: succeeds() });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "");
  assert.equal(confirmations().length, 0);
});

test("the exit code is preserved whatever auto-confirm does", async () => {
  await seedAnkitsFix();
  const failed = await run(["run", "npm", "run", "build"], { prompts: scripted(""), capture: failsWith(NPM_BUILD, 7) });
  assert.equal(failed.code, 7, "a failure's own code, with an entry written");
  assert.ok(pendingFor());

  const passed = await run(["run", "npm", "run", "build"], { capture: succeeds() });
  assert.equal(passed.code, 0, "and 0 when the confirmation is recorded");
  assert.equal(confirmations().length, 1);
});

test("a notebook that cannot be written cannot fail a command that passed", async () => {
  await seedAnkitsFix();
  await run(["run", "npm", "run", "build"], { prompts: scripted("") });

  const broken = { ...memory, append() { throw new Error("read-only filesystem"); } };
  const ui = sink();
  const code = await runCli(["run", "npm", "run", "build"], {
    ui: createDisplay(ui.out, ui.err),
    prompts: scripted(),
    memory: broken,
    capture: succeeds(),
    shouldInterrupt: () => false,
  });
  assert.equal(code, 0);
  assert.equal(ui.stdout(), "", "no half-written confirmation is announced");
  assert.equal(ui.stderr(), "");
  assert.equal(confirmations().length, 0);
});

// --- non-interactive --------------------------------------------------------

test("a run with no terminal creates nothing", async () => {
  await seedAnkitsFix();
  const quiet = { interactive: false, async ask() { return ""; }, async yes() { return false; }, close() {} };
  const r = await run(["run", "npm", "run", "build"], { prompts: quiet });
  assert.match(r.stdout, /Known error/);
  assert.deepEqual(pendingStore(), {}, "nobody was asked, so nobody skipped");
});
