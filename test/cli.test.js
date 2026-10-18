// Covers src/cli/ and src/explainer/, which shipped without tests.
//
// runCli takes a `deps` bag, so the flows are driven with scripted prompts and
// a stubbed capture (no npm spawn, no network) while display, memory and the
// fingerprint are the real ones. `errorbook sync` is the exception: it depends
// on the process cwd, so it runs in a child process against a throwaway repo.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable, PassThrough } from "node:stream";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runCli } from "../src/cli/cli.js";
import { createDisplay, relativeTime, displayName } from "../src/cli/display.js";
import { createPrompts } from "../src/cli/prompts.js";
import { createExplainer } from "../src/explainer/explainer.js";
import { append } from "../src/memory/index.js";
import { validateExplanation } from "../src/explainer/validate.js";

// Nothing here may depend on the caller's shell. A developer with
// ERRORBOOK_DIR exported for their own notebook, or ERRORBOOK_AUTHOR_NAME set
// for a demo, would otherwise run these tests against their own data and get
// failures that say nothing about the code. Cleared once, restored at the end.
const INHERITED = ["ERRORBOOK_DIR", "ERRORBOOK_AUTHOR", "ERRORBOOK_AUTHOR_NAME", "ERRORBOOK_AUTHOR_EMAIL"];
const callerEnv = Object.fromEntries(INHERITED.map((key) => [key, process.env[key]]));
for (const key of INHERITED) delete process.env[key];
after(() => {
  for (const key of INHERITED) {
    if (callerEnv[key] === undefined) delete process.env[key];
    else process.env[key] = callerEnv[key];
  }
});

const BIN = fileURLToPath(new URL("../bin/errorbook.js", import.meta.url));

// Runs the real CLI in a child process. A failing sync exits 1, which makes
// execFileSync throw, so the output is collected either way.
function cli(args, { cwd, env = {} }) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      cwd, encoding: "utf8", env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

// Every test gets its own empty notebook folder.
let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "eb-cli-"));
  process.env.ERRORBOOK_DIR = dir;
  process.env.ERRORBOOK_AUTHOR = "ankit";
});

// --- harness --------------------------------------------------------------

function sink(isTTY = false) {
  const out = [], err = [];
  const stream = (bucket) => {
    const s = new Writable({ write(c, e, cb) { bucket.push(c.toString()); cb(); } });
    s.isTTY = isTTY;
    return s;
  };
  return { out: stream(out), err: stream(err), stdout: () => out.join(""), stderr: () => err.join("") };
}

// A prompt source that answers from a list, so the interactive branches run
// without a terminal. Records what it was asked.
function scripted(...answers) {
  const asked = [];
  return {
    interactive: true,
    asked,
    closed: false,
    async ask(text) { asked.push(text); return String(answers.shift() ?? "").trim(); },
    async yes(text) { asked.push(text); return /^(y|yes)$/i.test(String(answers.shift() ?? "").trim()); },
    close() { this.closed = true; },
  };
}

// Real captures, so the ids here are the ids the notebook actually stores.
const sample = (name) => fs.readFileSync(new URL(`../samples/${name}`, import.meta.url), "utf8");
const NPM_BUILD = sample("npm-missing-script-ankit.txt");              // 6ce249
const NPM_OTHER = sample("npm-missing-script-doesnotexist-ankit.txt"); // e73c44

// Stands in for the capture module: reports one failure, returns its exit code.
const failsWith = (stderr, exitCode = 1) => async (argv, { onFailure }) => {
  await onFailure({ command: argv.join(" "), argv, stderr, exitCode, cwd: "/project", durationMs: 12 });
  return exitCode;
};

function stubExplainer(result = { status: "unavailable", reason: "offline", message: "no AI here" }) {
  return { calls: 0, offline: null, async explain(event, opts = {}) { this.calls++; this.offline = opts.offline; this.event = event; return result; } };
}

// Assembles the deps bag; every test overrides only what it cares about.
async function run(args, over = {}) {
  const ui = over.sink ?? sink();
  const prompts = over.prompts ?? scripted();
  const explainer = over.explainer ?? stubExplainer();
  const code = await runCli(args, {
    ui: createDisplay(ui.out, ui.err),
    prompts,
    explainer,
    capture: over.capture ?? failsWith(NPM_BUILD),
    shouldInterrupt: over.shouldInterrupt ?? (() => false),
    ...(over.sync ? { sync: over.sync } : {}),
  });
  return { code, prompts, explainer, stdout: ui.stdout(), stderr: ui.stderr() };
}

const notebook = () => fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"))
  .flatMap((f) => fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean).map(JSON.parse));

// --- the failure flow -----------------------------------------------------

test("an unknown error is reported, explained, and can be saved", async () => {
  const r = await run(["run", "npm", "run", "build"], {
    prompts: scripted("y", "Add a build script to package.json"),
  });

  assert.equal(r.code, 1, "the command's exit code is propagated");
  assert.match(r.stdout, /ERRORBOOK 6ce249/);
  assert.match(r.stdout, /This error is not in the notebook yet/);
  assert.equal(r.explainer.calls, 1, "the explainer is asked only when nothing is known");
  assert.match(r.stdout, /Saved[.] Run errorbook sync to share it[.]/);
  assert.doesNotMatch(r.stdout, /Team confidence/, "no internal detail");
  assert.doesNotMatch(r.stdout, /Saved fix/, "the fixId stays behind --verbose");

  const saved = notebook();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].type, "solved");
  assert.equal(saved[0].fingerprint, "6ce249");
  assert.equal(saved[0].fix, "Add a build script to package.json");
  assert.equal(saved[0].author, "ankit");
  assert.equal(r.prompts.closed, true, "the prompt source is always closed");
});

test("declining the save prompt writes nothing", async () => {
  const r = await run(["run", "npm", "run", "build"], { prompts: scripted("n") });
  assert.equal(notebook().length, 0);
  assert.doesNotMatch(r.stdout, /Saved fix/);
});

test("answering the save prompt with empty text writes nothing", async () => {
  const r = await run(["run", "npm", "run", "build"], { prompts: scripted("y", "") });
  assert.equal(notebook().length, 0);
  assert.match(r.stdout, /Not saved: no fix text supplied/);
});

test("the same error again is an exact match, and the AI is not asked", async () => {
  await run(["run", "npm", "run", "build"], { prompts: scripted("y", "Add a build script to package.json") });

  const r = await run(["run", "npm", "run", "build"], { prompts: scripted("", "n") });
  assert.match(r.stdout, /Known error - found in [0-9]+ms/);
  assert.match(r.stdout, /1\. Add a build script to package\.json/);
  assert.match(r.stdout, /confidence: unproven/);
  assert.equal(r.explainer.calls, 0, "a known error needs no AI explanation");
});

test("a different missing script loose-matches the saved fix", async () => {
  await run(["run", "npm", "run", "build"], { prompts: scripted("y", "Add a build script to package.json") });

  const r = await run(["run", "npm", "run", "doesnotexist"], {
    capture: failsWith(NPM_OTHER),
    prompts: scripted("", "n"),
  });
  assert.match(r.stdout, /ERRORBOOK e73c44/, "a different script is a different fingerprint");
  assert.match(r.stdout, /Similar error - found in [0-9]+ms/);
  assert.match(r.stdout, /Add a build script to package\.json/);
  assert.match(r.stdout, /not an exact match/);
  assert.equal(r.explainer.calls, 0);
});

// --- confirming ------------------------------------------------------------

test("a teammate's confirmation is recorded and raises confidence", async () => {
  await run(["run", "npm", "run", "build"], { prompts: scripted("y", "Add a build script to package.json") });

  process.env.ERRORBOOK_AUTHOR = "louis";
  const r = await run(["run", "npm", "run", "build"], { prompts: scripted("y", "n") });

  assert.match(r.stdout, /Recorded confirmed/);
  assert.match(r.stdout, /confirmed 1 - rejected 0/);
  assert.match(r.stdout, /confidence: medium/);
  const votes = notebook().filter((e) => e.type === "confirmed");
  assert.equal(votes.length, 1);
  assert.equal(votes[0].author, "louis");
  assert.equal(votes[0].fingerprint, "6ce249");
});

test("you cannot confirm your own fix, and nothing is written", async () => {
  await run(["run", "npm", "run", "build"], { prompts: scripted("y", "Add a build script to package.json") });

  const r = await run(["run", "npm", "run", "build"], { prompts: scripted("y", "n") });
  assert.match(r.stdout, /cannot confirm your own fix/);
  assert.equal(notebook().filter((e) => e.type === "confirmed").length, 0, "the self-vote is refused, not stored");
  assert.match(r.stdout, /confirmed 0 - rejected 0/);
});

test("a rejection is recorded against a loose match's own fingerprint", async () => {
  await run(["run", "npm", "run", "build"], { prompts: scripted("y", "Add a build script to package.json") });

  process.env.ERRORBOOK_AUTHOR = "louis";
  await run(["run", "npm", "run", "doesnotexist"], { capture: failsWith(NPM_OTHER), prompts: scripted("n", "n") });

  const votes = notebook().filter((e) => e.type === "rejected");
  assert.equal(votes.length, 1);
  assert.equal(votes[0].fingerprint, "6ce249", "the vote belongs to the fix's error, not the one just seen");
});

// --- list ------------------------------------------------------------------

test("list shows saved fixes without claiming a match kind", async () => {
  await run(["run", "npm", "run", "build"], { prompts: scripted("y", "Add a build script to package.json") });

  const r = await run(["list"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Fingerprint: 6ce249/);
  assert.match(r.stdout, /1\. Add a build script to package\.json/);
  assert.doesNotMatch(r.stdout, /Known error/, "a listing is not a match");
  assert.doesNotMatch(r.stdout, /found in/, "no lookup time in a listing");
  assert.doesNotMatch(r.stdout, /Similar error/);
});

test("list on an empty notebook says so", async () => {
  const r = await run(["list"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /No saved fixes yet/);
});

// --- degraded inputs -------------------------------------------------------

test("a failure with no stderr skips lookup instead of throwing", async () => {
  const r = await run(["run", "node", "x.js"], { capture: failsWith("", 3) });
  assert.equal(r.code, 3, "the exit code still comes through");
  assert.match(r.stdout, /No stderr fingerprint is available/);
  assert.equal(r.explainer.calls, 0);
  assert.equal(r.prompts.asked.length, 0, "nothing is offered to save when there is nothing to key it on");
  assert.equal(notebook().length, 0);
});

test("whitespace-only stderr is treated the same way", async () => {
  const r = await run(["run", "node", "x.js"], { capture: failsWith("   \n \t \n", 4) });
  assert.equal(r.code, 4);
  assert.match(r.stdout, /No stderr fingerprint is available/);
});

test("piped stdin is lookup-only: no prompts, nothing written", async () => {
  await (async () => {
    const ui = sink();
    await runCli(["run", "npm", "run", "build"], {
      ui: createDisplay(ui.out, ui.err),
      prompts: createPrompts({ input: new PassThrough(), output: ui.out }), // neither is a TTY
      explainer: stubExplainer(),
      capture: failsWith(NPM_BUILD),
      shouldInterrupt: () => false,
    });
    assert.match(ui.stdout(), /ERRORBOOK 6ce249/, "the lookup still runs");
    assert.doesNotMatch(ui.stdout(), /Save a new solution/, "but nothing is asked");
    assert.equal(notebook().length, 0);
  })();
});

test("a bare null line skips itself instead of taking out the notebook", async () => {
  await run(["run", "npm", "run", "build"], { prompts: scripted("y", "Add a build script to package.json") });

  // JSON.parse("null") succeeds, so this used to reach e.type and a.ts.
  const file = path.join(dir, "ankit.jsonl");
  fs.appendFileSync(file, "null\n{broken\n42\n[]\n\"a string\"\n");

  const listed = await run(["list"]);
  assert.equal(listed.code, 0, "list survives the junk");
  assert.match(listed.stdout, /Fingerprint: 6ce249/);
  assert.doesNotMatch(listed.stderr, /Cannot read properties/);

  const looked = await run(["run", "npm", "run", "build"], { prompts: scripted("", "n") });
  assert.match(looked.stdout, /Known error/, "lookup survives it too");
  assert.doesNotMatch(looked.stderr, /Assistance unavailable/);
});

// --- usage, errors and exit codes -----------------------------------------

test("usage and errors go to stderr, and exit codes are unchanged", async () => {
  const none = await run([]);
  assert.equal(none.code, 1);
  assert.match(none.stderr, /Usage:/);
  assert.equal(none.stdout, "", "usage must not pollute stdout");

  const help = await run(["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stderr, /Usage:/);
  assert.equal(help.stdout, "");

  const bogus = await run(["bogus"]);
  assert.equal(bogus.code, 1);
  assert.match(bogus.stderr, /Unknown command: bogus/);
  assert.equal(bogus.stdout, "");

  const bare = await run(["run"]);
  assert.equal(bare.code, 1);
  assert.match(bare.stderr, /no command given/);
  assert.equal(bare.stdout, "");
});

test("every byte of normal output is ASCII", async () => {
  await run(["run", "npm", "run", "build"], { prompts: scripted("y", "Add a build script to package.json") });
  const r = await run(["run", "npm", "run", "build"], {
    prompts: scripted("", "n"),
    explainer: stubExplainer({ status: "ok", source: "cache", value: { explanation: "No such script.", suggestedSteps: ["Run npm run."], caveats: ["Unconfirmed."] } }),
  });
  const listed = await run(["list"]);
  for (const [label, text] of [["run", r.stdout], ["list", listed.stdout]]) {
    const bad = [...text].filter((c) => c.charCodeAt(0) > 127);
    assert.deepEqual(bad, [], `${label} emitted non-ASCII: ${JSON.stringify(bad)}`);
  }
});

// --- display details ------------------------------------------------------

test("a multi-line fix stays indented under its own number", async () => {
  const ui = sink();
  createDisplay(ui.out, ui.err).fixes([
    { fix: "Add a build script:\n  \"build\": \"tsc\"\nthen reinstall", author: "ankit", confirmations: 0, rejections: 0, returned: false, confidence: "unproven", fixId: "abc" },
    { fix: "Second solution", author: "louis", confirmations: 0, rejections: 0, returned: false, confidence: "unproven", fixId: "def" },
  ], { kind: "exact" });

  const lines = ui.stdout().split("\n");
  const numbered = lines.filter((l) => /^\d+\. /.test(l));
  assert.equal(numbered.length, 2, "only real solutions start with a number");
  // Continuation lines are indented, so they cannot be mistaken for entries.
  assert.ok(lines.includes('     "build": "tsc"'), `expected an indented continuation, got ${JSON.stringify(lines)}`);
  assert.ok(lines.includes("   then reinstall"));
});

test("colour follows the TTY and NO_COLOR", async () => {
  const fixture = [{ fix: "x", author: "a", confirmations: 0, rejections: 0, returned: false, confidence: "unproven", fixId: "i" }];
  const colored = (isTTY, noColor) => {
    const before = process.env.NO_COLOR;
    if (noColor === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = noColor;
    const ui = sink(isTTY);
    createDisplay(ui.out, ui.err).fixes(fixture, { kind: "exact" });
    if (before === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = before;
    return /\x1b\[/.test(ui.stdout());
  };
  assert.equal(colored(true, undefined), true, "a terminal gets colour");
  assert.equal(colored(false, undefined), false, "a pipe does not");
  assert.equal(colored(true, "1"), false, "NO_COLOR=1 disables it");
  assert.equal(colored(true, ""), true, "an empty NO_COLOR is ignored, per the spec");
});

test("control characters in a saved fix cannot drive the terminal", async () => {
  const ui = sink();
  createDisplay(ui.out, ui.err).fixes([
    { fix: "\x1b[31mred\x1b[0m\x1b[2J\roverwrite", author: "a", confirmations: 0, rejections: 0, returned: false, confidence: "unproven", fixId: "i" },
  ], { kind: "exact" });
  const out = ui.stdout().replace(/\x1b\[36;1m|\x1b\[0m\n/g, ""); // the heading's own colour
  assert.doesNotMatch(out, /\x1b/, "no escape characters survive from notebook text");
  assert.doesNotMatch(out, /\r/);
});

// --- the explainer --------------------------------------------------------

test("the explainer falls back to cache offline, and reports when it cannot", async () => {
  // Deliberately not one of the seeded fingerprints: this test is about the
  // local cache filling up, so it must start with nothing to find.
  const event = { errorId: "c0ffee", normalizedError: 'npm error missing script: "build"', normalizationVersion: "test-1" };
  const cacheFile = path.join(dir, "local", "explanation-cache.json");
  const value = { explanation: "No such script.", suggestedSteps: ["Run npm run."], caveats: ["Unconfirmed."] };

  const offlineFirst = await createExplainer({ cacheFile, provider: async () => value }).explain(event, { offline: true });
  assert.equal(offlineFirst.status, "unavailable");
  assert.equal(offlineFirst.reason, "offline");

  const live = await createExplainer({ cacheFile, provider: async () => value }).explain(event, {});
  assert.equal(live.status, "ok");
  assert.equal(live.source, "live");

  // Now it is cached, so offline succeeds without a provider at all.
  const cached = await createExplainer({
    cacheFile,
    provider: async () => { throw new Error("the provider must not be called"); },
  }).explain(event, { offline: true });
  assert.equal(cached.status, "ok");
  assert.equal(cached.source, "cache");
  assert.equal(cached.cacheSource, "local");
  assert.deepEqual(cached.value, value);
});

test("the committed seed answers the demo's errors with no key and no local cache", async () => {
  // The whole point of the seed: a fresh clone, offline, still explains these.
  const cacheFile = path.join(dir, "local", "explanation-cache.json");
  const explainer = createExplainer({
    cacheFile,
    provider: async () => { throw new Error("the provider must not be called"); },
  });

  for (const errorId of ["6ce249", "fb4768", "28b25a", "27dfb3"]) {
    const r = await explainer.explain(
      { errorId, normalizedError: `whatever ${errorId} looked like here`, normalizationVersion: "test-1" },
      { offline: true },
    );
    assert.equal(r.status, "ok", `${errorId} is not seeded`);
    assert.equal(r.cacheSource, "seed", `${errorId} did not come from the seed`);
    assert.match(r.value.explanation, /\S/);
    assert.equal(r.value.suggestedSteps.length > 0, true, `${errorId} suggests nothing`);
  }

  // Keyed on the fingerprint, so it survives being written on another machine,
  // but an unseeded error still gets nothing.
  const miss = await explainer.explain(
    { errorId: "000000", normalizedError: "unknown", normalizationVersion: "test-1" },
    { offline: true },
  );
  assert.equal(miss.status, "unavailable");
  assert.equal(miss.reason, "offline");
});

test("the seed cache is well formed and claims its provenance", async () => {
  const seed = JSON.parse(fs.readFileSync(new URL("../src/explainer/seed-cache.json", import.meta.url), "utf8"));
  assert.equal(seed.schemaVersion, 1);
  assert.deepEqual(Object.keys(seed.entries).sort(), ["27dfb3", "28b25a", "6ce249", "fb4768"]);
  for (const [id, entry] of Object.entries(seed.entries)) {
    assert.doesNotThrow(() => validateExplanation(entry), `${id} is not a valid explanation`);
    assert.ok(entry._source?.label, `${id} does not say what it is`);
    assert.ok(entry._source?.model, `${id} does not say where it came from`);
    // Nothing machine-specific, and above all no credentials, ship in here.
    const text = JSON.stringify(entry);
    assert.doesNotMatch(text, /AIza|x-goog-api-key|GEMINI_API_KEY/i, `${id} mentions a key`);
    assert.doesNotMatch(text, /C:\\\\Users|\/home\/|\/Users\//, `${id} embeds a local path`);
  }
});

test("a provider failure is reported, not thrown, and a malformed answer is rejected", async () => {
  const event = { errorId: "a1b2c3", normalizedError: "boom", normalizationVersion: "test-1" };
  const cacheFile = path.join(dir, "local", "explanation-cache.json");

  const broke = await createExplainer({
    cacheFile,
    provider: async () => { throw Object.assign(new Error("Could not reach ai.example.com (ECONNREFUSED). Run with --offline to skip the AI."), { reason: "unreachable" }); },
  }).explain(event, {});
  assert.equal(broke.status, "unavailable");
  assert.equal(broke.reason, "unreachable");
  assert.match(broke.message, /--offline/, "the message says what to do about it");

  const junk = await createExplainer({ cacheFile, provider: async () => ({ explanation: "" }) }).explain(event, {});
  assert.equal(junk.status, "unavailable");
  assert.equal(junk.reason, "invalid_response");

  const noFingerprint = await createExplainer({ cacheFile, provider: async () => ({}) }).explain({}, {});
  assert.equal(noFingerprint.reason, "invalid_input");
});

test("the AI adapter times out well before the OS does, with an actionable message", async () => {
  const { aiAdapter } = await import("../src/explainer/aiAdapter.js");
  const event = { errorId: "a1b2c3", normalizedError: "boom" };

  // No endpoint override and no key. The key is passed explicitly rather than
  // relying on the environment, which may well have a real one exported.
  const unset = await aiAdapter(event, { url: "", key: "" }).catch((e) => e);
  assert.equal(unset.reason, "not_configured");
  assert.match(unset.message, /GEMINI_API_KEY/);
  assert.match(unset.message, /--offline/);

  // 10.255.255.1 is unroutable: the OS connect timeout is far longer than ours.
  const started = Date.now();
  const timedOut = await aiAdapter(event, { url: "http://10.255.255.1:8731/x", timeoutMs: 1000 }).catch((e) => e);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 5000, `gave up in ${elapsed}ms, so the abort signal beat the OS`);
  assert.ok(["timeout", "unreachable"].includes(timedOut.reason), `unexpected reason ${timedOut.reason}`);
  assert.doesNotMatch(timedOut.message, /^fetch failed$/, "never Node's bare message");
  assert.match(timedOut.message, /10\.255\.255\.1/, "says which host");
  assert.match(timedOut.message, /--offline/, "says what to do");
});

// --- sync ------------------------------------------------------------------

test("sync's result decides the exit code", async () => {
  const ok = await run(["sync"], { sync: async () => ({ ok: true }) });
  assert.equal(ok.code, 0);
  const bad = await run(["sync"], { sync: async () => ({ ok: false, step: "pull" }) });
  assert.equal(bad.code, 1);
});

test("sync in a repo with no remote fails gracefully and commits nothing", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "eb-repo-"));
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q", ".");
  git("config", "user.email", "t@t");
  git("config", "user.name", "tester");
  git("commit", "-q", "--allow-empty", "-m", "init");
  const commits = () => git("rev-list", "--count", "HEAD");
  assert.equal(commits(), "1");

  const sync = () => cli(["sync"], { cwd: repo, env: { ERRORBOOK_DIR: path.join(repo, ".errorbook") } });

  // Nothing of ours to share: no commit may appear, however often it is run.
  const first = sync();
  assert.equal(first.code, 1, "no remote is a failure, but a reported one");
  assert.match(first.stdout, /No new notes of yours to share/);
  assert.match(first.stdout, /Couldn't get teammates' notes/, "no remote is reported, not thrown");
  assert.doesNotMatch(first.stdout, /Saved your new notes/);
  assert.doesNotMatch(first.stderr, /at .*\n\s+at /, "no stack trace reaches the user");
  sync();
  assert.equal(commits(), "1", "a failed sync must not leave commits behind");

  // With a real note, it does commit, and carries .gitattributes along.
  fs.writeFileSync(
    path.join(repo, ".errorbook", "ankit.jsonl"),
    JSON.stringify({ v: 1, type: "solved", fingerprint: "6ce249", fixId: "a1", fix: "Add a build script", author: "ankit", ts: "2026-10-18T00:00:00Z" }) + "\n",
  );
  const withNote = sync();
  assert.match(withNote.stdout, /Saved your new notes \(.*ankit\.jsonl.*\)/);
  assert.equal(commits(), "2");
  const tracked = git("ls-tree", "-r", "--name-only", "HEAD");
  assert.match(tracked, /\.errorbook\/ankit\.jsonl/);
  assert.match(tracked, /\.errorbook\/\.gitattributes/, ".gitattributes rides along with the first real note");

  // And again with nothing new: still two commits.
  sync();
  assert.equal(commits(), "2");
  fs.rmSync(repo, { recursive: true, force: true });
});

test("sync outside a git repo bails before touching anything", () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "eb-plain-"));
  const out = cli(["sync"], {
    cwd: plain,
    env: {
      ERRORBOOK_DIR: path.join(plain, ".errorbook"),
      GIT_CEILING_DIRECTORIES: os.tmpdir(),
    },
  });
  assert.equal(out.code, 1);
  assert.match(out.stdout, /isn't a git repository/);
  assert.equal(fs.existsSync(path.join(plain, ".errorbook", ".gitattributes")), false, "nothing is written");
  fs.rmSync(plain, { recursive: true, force: true });
});

// --- the demo-facing output ------------------------------------------------

test("relativeTime reads as a person would say it", () => {
  const now = Date.parse("2026-10-18T12:00:00Z");
  const ago = (iso) => relativeTime(iso, now);
  assert.equal(ago("2026-10-18T11:59:30Z"), "just now");
  assert.equal(ago("2026-10-18T11:58:00Z"), "2 minutes ago");
  assert.equal(ago("2026-10-18T11:00:00Z"), "1 hour ago");
  assert.equal(ago("2026-10-17T12:00:00Z"), "1 day ago");
  assert.equal(ago("2026-10-04T12:00:00Z"), "2 weeks ago");
  assert.equal(ago("2026-08-18T12:00:00Z"), "2 months ago");
  assert.equal(ago("2024-10-18T12:00:00Z"), "2 years ago");
  // A teammate's clock can run ahead of ours; that is not "-1 minutes ago".
  assert.equal(ago("2026-10-18T12:05:00Z"), "just now");
  assert.equal(relativeTime(undefined, now), null, "a missing timestamp shows nothing");
  assert.equal(relativeTime("not a date", now), null);
});

test("an author slug is shown as a first name, but stored whole", async () => {
  assert.equal(displayName("ankit-aggarwal"), "ankit");
  assert.equal(displayName("louisa-tambunting"), "louisa");
  assert.equal(displayName("ankit"), "ankit");
  assert.equal(displayName(""), "someone");
  assert.equal(displayName(null), "someone");

  process.env.ERRORBOOK_AUTHOR = "Ankit Aggarwal";
  const r = await run(["run", "npm", "run", "build"], { prompts: scripted("y", "Add a build script") });
  assert.match(r.stdout, /Saved[.]/);
  assert.equal(notebook()[0].author, "ankit-aggarwal", "storage keeps the full slug");

  const listed = await run(["list"]);
  assert.match(listed.stdout, /fixed by ankit -/);
  assert.doesNotMatch(listed.stdout, /ankit-aggarwal/, "the slug is not shown to a reader");
});

test("the match heading carries the lookup time", async () => {
  await run(["run", "npm", "run", "build"], { prompts: scripted("y", "Add a build script") });
  const r = await run(["run", "npm", "run", "build"], { prompts: scripted("") });
  const heading = r.stdout.split("\n").find((l) => l.startsWith("Known error"));
  assert.ok(heading, `no heading in ${JSON.stringify(r.stdout)}`);
  assert.match(heading, /^Known error - found in [0-9]+ms$/);
});

test("a fix shows when it was found, and not its fixId", async () => {
  await run(["run", "npm", "run", "build"], { prompts: scripted("y", "Add a build script") });
  const r = await run(["run", "npm", "run", "build"], { prompts: scripted("") });
  assert.match(r.stdout, /fixed by ankit - just now/);
  assert.doesNotMatch(r.stdout, /fix [0-9a-f]{8}/, "the fixId means nothing to a reader");
  assert.doesNotMatch(r.stdout, /Language: npm/, "the loose description is verbose-only");
});

test("--verbose restores the loose description and the fixId", async () => {
  await run(["run", "npm", "run", "build"], { prompts: scripted("y", "Add a build script") });
  const r = await run(["run", "--verbose", "npm", "run", "build"], { prompts: scripted("") });
  assert.match(r.stdout, /Language: npm - type: missing-script - file: -/);
  assert.match(r.stdout, /- fix [0-9a-f]{8}/);

  const listed = await run(["list", "--verbose"]);
  assert.match(listed.stdout, /- fix [0-9a-f]{8}/);
});

test("--offline and --verbose combine, in either order", async () => {
  for (const flags of [["--offline", "--verbose"], ["--verbose", "--offline"]]) {
    const r = await run(["run", ...flags, "npm", "run", "build"], { prompts: scripted("n") });
    assert.equal(r.explainer.offline, true, `offline lost with ${flags.join(" ")}`);
    assert.match(r.stdout, /Language: npm/, `verbose lost with ${flags.join(" ")}`);
  }
});

test("a loose match warns before it advises, not after", async () => {
  await run(["run", "npm", "run", "build"], { prompts: scripted("y", "Add a build script") });
  const r = await run(["run", "npm", "run", "doesnotexist"], {
    capture: failsWith(NPM_OTHER),
    prompts: scripted(""),
  });
  const caveat = r.stdout.indexOf("not an exact match");
  const fix = r.stdout.indexOf("1. Add a build script");
  assert.ok(caveat > -1 && fix > -1, "both lines are present");
  assert.ok(caveat < fix, "the caveat must be read before the fix, not after it");
});

test("a known error asks one question, not two", async () => {
  await run(["run", "npm", "run", "build"], { prompts: scripted("y", "Add a build script") });

  // Skipping the verdict used to be followed by "Save a new solution?".
  const skipped = await run(["run", "npm", "run", "build"], { prompts: scripted("") });
  assert.equal(skipped.prompts.asked.length, 1, `asked ${JSON.stringify(skipped.prompts.asked)}`);
  assert.doesNotMatch(skipped.prompts.asked.join(" "), /Save a new solution/);

  // Answering it is also one question (one fix, so no "which one" step).
  process.env.ERRORBOOK_AUTHOR = "louis";
  const answered = await run(["run", "npm", "run", "build"], { prompts: scripted("y") });
  assert.equal(answered.prompts.asked.length, 1);
  assert.match(answered.stdout, /Recorded confirmed/);
});

test("when every known fix has failed, a new one is worth asking for", async () => {
  await run(["run", "npm", "run", "build"], { prompts: scripted("y", "A dead end") });
  const solved = notebook()[0];
  // Two different people reject it, which the confidence table calls "failed".
  // The votes have to be dated after the fix they are about, or the notebook
  // rightly ignores them as votes for something it has not seen yet.
  const later = new Date(Date.parse(solved.ts) + 60_000).toISOString();
  for (const author of ["louis", "mara"]) {
    fs.appendFileSync(path.join(dir, `${author}.jsonl`),
      JSON.stringify({ v: 1, type: "rejected", fingerprint: "6ce249", fixId: solved.fixId, author, ts: later }) + "\n");
  }

  const r = await run(["run", "npm", "run", "build"], { prompts: scripted("", "y", "The real fix") });
  assert.match(r.stdout, /confidence: failed - confirmed 0 - rejected 2/);
  assert.match(r.prompts.asked.join(" "), /Save a new solution/, "a dead end must be replaceable");
  assert.match(r.stdout, /Saved[.]/);
  assert.equal(notebook().filter((e) => e.type === "solved" && e.fix === "The real fix").length, 1);
});

// --- the Gemini adapter ----------------------------------------------------
// Driven against a local stub, so the suite never calls Google and needs no key.

import { createServer } from "node:http";
import { trimForPrompt } from "../src/explainer/aiAdapter.js";

async function stubGemini(handler) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      seen.push({ headers: req.headers, body: body ? JSON.parse(body) : null });
      handler(req, res, body);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}/v1beta/models/x:generateContent`, seen, close: () => new Promise((r) => server.close(r)) };
}
const geminiReply = (obj) => (_req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] }, finishReason: "STOP" }] }));
};

test("a Gemini reply is parsed into the shape validate.js expects", async () => {
  const { aiAdapter } = await import("../src/explainer/aiAdapter.js");
  const stub = await stubGemini(geminiReply({
    whatWentWrong: "There is no build script.",
    whatToTry: "Add one to package.json.",
  }));
  try {
    const out = await aiAdapter({ errorId: "6ce249", normalizedError: "npm error missing script" }, { url: stub.url, key: "test-key-not-real" });
    assert.deepEqual(out, {
      explanation: "There is no build script.",
      suggestedSteps: ["Add one to package.json."],
      caveats: [],
    });
    assert.doesNotThrow(() => validateExplanation(out));

    // The key travels in the header, never in the URL or the body.
    assert.equal(stub.seen[0].headers["x-goog-api-key"], "test-key-not-real");
    assert.doesNotMatch(stub.url, /test-key-not-real/);
    assert.doesNotMatch(JSON.stringify(stub.seen[0].body), /test-key-not-real/);

    // And it asks for JSON back rather than hoping for it.
    assert.equal(stub.seen[0].body.generationConfig.responseMimeType, "application/json");
    assert.ok(stub.seen[0].body.systemInstruction.parts[0].text.includes("untrusted data"));
  } finally {
    await stub.close();
  }
});

test("a thinking part before the answer is skipped", async () => {
  const { aiAdapter } = await import("../src/explainer/aiAdapter.js");
  const stub = await stubGemini((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ candidates: [{ content: { parts: [
      { text: "Let me consider the stack trace...", thought: true },
      { text: JSON.stringify({ whatWentWrong: "Port is taken.", whatToTry: "Stop the other server." }) },
    ] } }] }));
  });
  try {
    const out = await aiAdapter({ errorId: "28b25a", normalizedError: "EADDRINUSE" }, { url: stub.url, key: "k" });
    assert.equal(out.explanation, "Port is taken.");
  } finally {
    await stub.close();
  }
});

test("a stub that already returns the final shape is left alone", async () => {
  const { aiAdapter } = await import("../src/explainer/aiAdapter.js");
  const ready = { explanation: "Already shaped.", suggestedSteps: ["Nothing to map."], caveats: [] };
  const stub = await stubGemini((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(ready));
  });
  try {
    assert.deepEqual(await aiAdapter({ errorId: "x", normalizedError: "y" }, { url: stub.url, key: "k" }), ready);
  } finally {
    await stub.close();
  }
});

test("a bad Gemini response is reported, and never quotes the request back", async () => {
  const { aiAdapter } = await import("../src/explainer/aiAdapter.js");
  const KEY = "super-secret-test-key";

  const cases = [
    ["not json at all", (_q, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end("<html>nope"); }, "invalid_response"],
    ["no candidates", geminiReply, "invalid_response"],
    ["prose instead of json", (_q, res) => { res.writeHead(200); res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: "I think the build broke." }] } }] })); }, "invalid_response"],
    ["blocked", (_q, res) => { res.writeHead(200); res.end(JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } })); }, "blocked"],
    ["http 429", (_q, res) => { res.writeHead(429); res.end(JSON.stringify({ error: { message: `your key ${KEY} is over quota` } })); }, "http_error"],
    ["http 403", (_q, res) => { res.writeHead(403); res.end(`forbidden for key ${KEY}`); }, "http_error"],
  ];

  for (const [label, handler, reason] of cases) {
    const stub = await stubGemini(typeof handler === "function" && handler.length === 2 ? handler : handler({}));
    try {
      const e = await aiAdapter({ errorId: "x", normalizedError: "y" }, { url: stub.url, key: KEY }).catch((err) => err);
      assert.equal(e.reason, reason, `${label}: got ${e.reason} (${e.message})`);
      // The key must never surface in a message, however the server behaves.
      assert.doesNotMatch(e.message, new RegExp(KEY), `${label} leaked the key`);
      assert.doesNotMatch(e.message, /x-goog-api-key/i, `${label} leaked the headers`);
    } finally {
      await stub.close();
    }
  }
});

test("a 429 says it is a rate limit, and a 403 points at the key", async () => {
  const { aiAdapter } = await import("../src/explainer/aiAdapter.js");
  const stub429 = await stubGemini((_q, res) => { res.writeHead(429); res.end("{}"); });
  const stub403 = await stubGemini((_q, res) => { res.writeHead(403); res.end("{}"); });
  try {
    const a = await aiAdapter({ errorId: "x", normalizedError: "y" }, { url: stub429.url, key: "k" }).catch((e) => e);
    assert.match(a.message, /rate limited/);
    const b = await aiAdapter({ errorId: "x", normalizedError: "y" }, { url: stub403.url, key: "k" }).catch((e) => e);
    assert.match(b.message, /GEMINI_API_KEY is valid/);
  } finally {
    await stub429.close();
    await stub403.close();
  }
});

test("a huge stderr is trimmed at both ends before being sent", () => {
  const short = "Error: small\n    at x";
  assert.equal(trimForPrompt(short), short, "a normal error is sent whole");

  const huge = "HEAD-MARKER\n" + "    at repeated (frame.js:1:1)\n".repeat(5000) + "TAIL-MARKER";
  const sent = trimForPrompt(huge);
  assert.ok(sent.length < 4200, `trimmed to ${sent.length}`);
  assert.match(sent, /HEAD-MARKER/, "the error line at the top survives");
  assert.match(sent, /TAIL-MARKER/, "and the fatal line at the bottom");
  assert.match(sent, /characters of repeated frames omitted/);
  assert.equal(trimForPrompt(undefined), "");
});

test("sync reports the real path of a modified tracked notebook file", () => {
  // Regression: raw() trimmed git's whole stdout, which removed the leading
  // space of " M .errorbook/ankit.jsonl". Slicing the three-character status
  // prefix then ate the dot and sync said "errorbook/ankit.jsonl". Untracked
  // files were unaffected, because "?? path" has no leading space.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "eb-sync-"));
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q", ".");
  git("config", "user.email", "t@t");
  git("config", "user.name", "tester");

  const note = (fix) => JSON.stringify({
    v: 1, type: "solved", fingerprint: "6ce249", fixId: "a1", fix, author: "ankit", ts: "2026-10-18T00:00:00Z",
  });
  const book = path.join(repo, ".errorbook");
  fs.mkdirSync(book, { recursive: true });
  fs.writeFileSync(path.join(book, "ankit.jsonl"), note("Add a build script") + "\n");

  // Commit it, so the next change is a modification of a tracked file.
  git("add", "-A");
  git("commit", "-q", "-m", "first note");
  assert.equal(git("rev-list", "--count", "HEAD"), "1");

  // Now modify it, and confirm git really does report it with a leading space.
  fs.appendFileSync(path.join(book, "ankit.jsonl"), note("And run npm install") + "\n");
  assert.equal(git("status", "--porcelain", "--", ".errorbook"), "M .errorbook/ankit.jsonl".trim(),
    "sanity: trimmed porcelain is exactly what used to be parsed");

  const run = cli(["sync"], { cwd: repo, env: { ERRORBOOK_DIR: book } });
  assert.match(run.stdout, /Saved your new notes \(\.errorbook\/ankit\.jsonl\)/,
    `path lost its leading dot: ${JSON.stringify(run.stdout)}`);

  // And the commit really contains that file.
  assert.equal(git("rev-list", "--count", "HEAD"), "2");
  // .gitattributes rides along with the first real note, so check membership.
  assert.ok(git("show", "--pretty=format:", "--name-only", "HEAD").includes(".errorbook/ankit.jsonl"),
    "the modified note is not in the commit");
  assert.match(git("show", "HEAD:.errorbook/ankit.jsonl"), /And run npm install/);

  // An untracked file still works, and so does a path with a space in it.
  fs.writeFileSync(path.join(book, "ankit laptop.jsonl"), note("Third fix") + "\n");
  const second = cli(["sync"], { cwd: repo, env: { ERRORBOOK_DIR: book } });
  assert.match(second.stdout, /Saved your new notes \(\.errorbook\/ankit laptop\.jsonl\)/,
    `-z should leave an unquoted path: ${JSON.stringify(second.stdout)}`);
  assert.ok(git("show", "--pretty=format:", "--name-only", "HEAD").includes(".errorbook/ankit laptop.jsonl"),
    "the spaced filename is not in the commit");

  fs.rmSync(repo, { recursive: true, force: true });
});
