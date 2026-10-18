// Covers `errorbook scan`: the read-back that reports notebook lines still
// carrying something that looks like a credential.
//
// The standing assertion in every case here is the negative one -- that the
// secret the fixture planted appears in neither stdout nor stderr. `leaks()`
// makes that check one call, and the cases are built so that a regression in
// the printer trips it rather than merely changing a count.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { runCli } from "../src/cli/cli.js";
import { createDisplay } from "../src/cli/display.js";
import { runScan, scanDir, scanLine, maskField, stringFields } from "../src/scan/index.js";

// Nothing here may depend on the caller's shell. A developer with
// ERRORBOOK_DIR exported for their own notebook, or ERRORBOOK_AUTHOR_NAME set
// for a demo, would otherwise run these tests against their own data -- and in
// this file in particular, scan would then read their real notebook. Cleared
// once, restored at the end.
const INHERITED = ["ERRORBOOK_DIR", "ERRORBOOK_AUTHOR", "ERRORBOOK_AUTHOR_NAME", "ERRORBOOK_AUTHOR_EMAIL"];
const callerEnv = Object.fromEntries(INHERITED.map((key) => [key, process.env[key]]));
for (const key of INHERITED) delete process.env[key];
after(() => {
  for (const key of INHERITED) {
    if (callerEnv[key] === undefined) delete process.env[key];
    else process.env[key] = callerEnv[key];
  }
});

// Throwaway notebook folders. `files` maps a .jsonl name to its contents.
const temps = [];
function notebook(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "errorbook-scan-"));
  temps.push(dir);
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  return dir;
}
after(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

function sink() {
  const out = [], err = [];
  const stream = (bucket) => new Writable({ write(c, e, cb) { bucket.push(c.toString()); cb(); } });
  return { out: stream(out), err: stream(err), stdout: () => out.join(""), stderr: () => err.join("") };
}

// Runs the command over a folder and reports what it printed.
function scan(dir, over = {}) {
  const ui = sink();
  const code = runScan({ ui: createDisplay(ui.out, ui.err), dir, ...over });
  return { code, stdout: ui.stdout(), stderr: ui.stderr(), both: ui.stdout() + ui.stderr() };
}

// The assertion this whole file exists for.
function leaks(result, ...secrets) {
  for (const secret of secrets) {
    assert.ok(!result.stdout.includes(secret), `stdout leaked ${secret.slice(0, 4)}...`);
    assert.ok(!result.stderr.includes(secret), `stderr leaked ${secret.slice(0, 4)}...`);
  }
}

// Credentials scrub() is known to mask, each in the shape a notebook line
// stores it in. Distinct values, so a leak names which case leaked.
const GH_TOKEN = "ghp_0123456789abcdefghijABCDEFGHIJ0123";
const OPENAI_KEY = "sk-abcdefghijklmnopqrstuvwxyz012345";
const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";
const PASSWORD = "hunter2-correct-horse";
const line = (event) => `${JSON.stringify(event)}\n`;

// --- the field walk and the masker ----------------------------------------

test("stringFields walks nested objects and arrays by path", () => {
  const fields = stringFields({ fix: "a", loose: { file: "b", lang: "npm" }, argv: ["x", "y"], n: 7, ok: true });
  assert.deepEqual(fields, [["fix", "a"], ["loose.file", "b"], ["loose.lang", "npm"], ["argv[0]", "x"], ["argv[1]", "y"]]);
});

test("maskField masks a value that is a credential on its own", () => {
  const masked = maskField("fix", `export GH=${GH_TOKEN}`);
  assert.ok(masked, "a github token is a finding wherever it sits");
  assert.ok(!masked.includes(GH_TOKEN));
  assert.match(masked, /\[redacted\]/);
});

test("maskField masks a plain value when the field NAME is what makes it a secret", () => {
  // "hunter2-correct-horse" alone is just a word; next to a password key it is
  // a credential. This is the case a value-only check would miss.
  assert.equal(maskField("fix", PASSWORD), null, "the same text under a harmless name is not a finding");
  const masked = maskField("password", PASSWORD);
  assert.ok(masked, "the field name supplies the context");
  assert.ok(!masked.includes(PASSWORD));
});

test("a clean field is not a finding", () => {
  assert.equal(maskField("fix", "Add a build script to package.json"), null);
});

// --- line scanning ---------------------------------------------------------

test("a finding names the field that holds the credential", () => {
  const findings = scanLine(line({ type: "solved", fingerprint: "6ce249", fix: `run: curl -H "token: ${OPENAI_KEY}"` }));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].field, "fix");
  assert.ok(!findings[0].masked.includes(OPENAI_KEY));
});

test("blank lines and whitespace-only lines are not findings", () => {
  assert.deepEqual(scanLine(""), []);
  assert.deepEqual(scanLine("   \t "), []);
  assert.deepEqual(scanLine("﻿"), []);
});

test("a corrupt line is still scanned, reported against - rather than skipped", () => {
  // The line cannot be parsed, so no field can be named -- but a credential in
  // it must not be lost just because the JSON is broken.
  const findings = scanLine(`{ broken, "fix": "${AWS_KEY}"`);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].field, "-");
  assert.ok(!findings[0].masked.includes(AWS_KEY));
});

test("a corrupt line with nothing secret in it is not a finding", () => {
  assert.deepEqual(scanLine("{ broken json"), []);
  assert.deepEqual(scanLine("42"), []);
  assert.deepEqual(scanLine("null"), []);
  assert.deepEqual(scanLine("[]"), []);
});

test("a non-object line carrying a credential is reported", () => {
  const findings = scanLine(JSON.stringify([`password=${PASSWORD}`]));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].field, "-");
  assert.ok(!findings[0].masked.includes(PASSWORD));
});

// --- the folder ------------------------------------------------------------

test("findings carry file name and line number, counted from 1", () => {
  const dir = notebook({
    "ankit.jsonl":
      line({ type: "solved", fix: "Add a build script" }) +
      "\n" +
      line({ type: "solved", fix: `export OPENAI_API_KEY=${OPENAI_KEY}` }),
  });
  const { findings } = scanDir({ dir });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].file, "ankit.jsonl");
  assert.equal(findings[0].line, 3, "the blank line is counted, so the number matches an editor");
  assert.equal(findings[0].field, "fix");
});

test("every .jsonl in the folder is read, and nothing else is", () => {
  const dir = notebook({
    "ankit.jsonl": line({ fix: `token: ${GH_TOKEN}` }),
    "louisa.jsonl": line({ fix: `key: ${AWS_KEY}` }),
    "notes.txt": `password=${PASSWORD}`,
  });
  const { findings, files } = scanDir({ dir });
  assert.equal(files, 2);
  assert.deepEqual(findings.map((f) => f.file), ["ankit.jsonl", "louisa.jsonl"]);
});

test("a notebook of lookup lines is clean, and every line is still counted", () => {
  const dir = notebook({
    "ankit.jsonl":
      line({ type: "lookup", fingerprint: "6ce249", result: "hit" }) +
      line({ type: "lookup", fingerprint: "e73c44", result: "loose" }) +
      line({ type: "lookup", fingerprint: "28b25a", result: "miss" }),
  });
  const result = scanDir({ dir });
  assert.deepEqual(result.findings, [], "there is nothing in a lookup line to find");
  assert.equal(result.lines, 3, "and nothing is skipped either");
  assert.equal(scan(dir).code, 0);
});

// --- the command -----------------------------------------------------------

test("a clean notebook prints clean on stdout and exits 0", () => {
  const dir = notebook({
    "ankit.jsonl": line({ type: "solved", fingerprint: "6ce249", fix: "Add a build script to package.json" }),
  });
  const result = scan(dir);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "clean\n", "stdout is the word and nothing else");
  assert.equal(result.stderr, "");
});

test("a finding goes to stderr, keeps stdout empty, exits 1, and never prints the secret", () => {
  const dir = notebook({
    "ankit.jsonl":
      line({ type: "solved", fingerprint: "6ce249", fix: `Set the header: Authorization: Bearer ${GH_TOKEN}` }) +
      line({ type: "solved", fingerprint: "204e89", password: PASSWORD }),
  });
  const result = scan(dir);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "", "a dirty notebook says nothing on stdout, so stdout stays a clean signal");
  leaks(result, GH_TOKEN, PASSWORD);
  assert.match(result.stderr, /ankit\.jsonl:1 fix /);
  assert.match(result.stderr, /ankit\.jsonl:2 password /);
  assert.match(result.stderr, /2 findings in 1 file/);
  assert.match(result.stderr, /\[redacted\]/);
});

test("the report is ASCII only, one line per finding", () => {
  const dir = notebook({
    // A notebook line is free to hold control characters and non-ASCII; the
    // report is not. A smuggled newline here would forge a second finding.
    "ankit.jsonl": line({ fix: `café — line\nbreak \u001b[31mred\u001b[0m token: ${OPENAI_KEY}` }),
  });
  const result = scan(dir);
  assert.equal(result.code, 1);
  leaks(result, OPENAI_KEY);
  // eslint-disable-next-line no-control-regex -- asserting the absence of them
  assert.doesNotMatch(result.stderr, /[^\x09\x0a\x20-\x7e]/, "no escapes, no non-ASCII");
  const findings = result.stderr.split("\n").filter((l) => /^ankit\.jsonl:/.test(l));
  assert.equal(findings.length, 1, "one finding is one line, whatever the stored text contained");
});

test("a very long credential line is clipped, and the clipping cannot reveal anything", () => {
  // Long but unremarkable prose: a 400-character run of one character is
  // itself masked as a base64 blob, which would clip nothing.
  const dir = notebook({ "ankit.jsonl": line({ fix: `${"check the build step. ".repeat(20)}token: ${GH_TOKEN}` }) });
  const result = scan(dir);
  leaks(result, GH_TOKEN);
  const finding = result.stderr.split("\n").find((l) => l.startsWith("ankit.jsonl:"));
  assert.ok(finding.length < 220, "the finding fits a terminal line");
  assert.match(finding, /\.\.\.$/);
});

test("an empty notebook folder is clean", () => {
  assert.equal(scan(notebook({})).code, 0);
  assert.equal(scan(notebook({ "ankit.jsonl": "" })).stdout, "clean\n");
});

test("a notebook folder that does not exist yet is clean, but a named one that is missing fails", () => {
  const absent = path.join(notebook({}), "not-there");
  // Explicitly asked for: a typo in the argument is worth an exit 1.
  const named = scan(absent);
  assert.equal(named.code, 1);
  assert.match(named.stderr, /does not exist/);
  // The default notebook folder simply not existing yet is a fresh checkout.
  const ui = sink();
  const code = runScan({ ui: createDisplay(ui.out, ui.err), notebookDir: absent });
  assert.equal(code, 0);
  assert.equal(ui.stdout(), "clean\n");
});

test("a folder that cannot be read is never called clean", () => {
  const result = scan("/any", {
    fs: { readdirSync() { const e = new Error("denied"); e.code = "EACCES"; throw e; } },
  });
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "", "no clean over a folder we failed to read");
  assert.match(result.stderr, /EACCES/);
});

test("a file that cannot be read fails the scan without stopping the others", () => {
  const dir = notebook({ "ankit.jsonl": line({ fix: "fine" }), "louisa.jsonl": line({ fix: "also fine" }) });
  const real = fs.readFileSync;
  const result = scan(dir, {
    fs: {
      readdirSync: (d) => fs.readdirSync(d),
      readFileSync: (file, enc) => {
        if (String(file).endsWith("louisa.jsonl")) { const e = new Error("denied"); e.code = "EACCES"; throw e; }
        return real(file, enc);
      },
    },
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /louisa\.jsonl \(EACCES\)/);
  assert.equal(result.stdout, "");
});

test("scan writes nothing: the notebook is byte-identical afterwards", () => {
  const body = line({ type: "solved", fix: `token: ${GH_TOKEN}` });
  const dir = notebook({ "ankit.jsonl": body });
  const file = path.join(dir, "ankit.jsonl");
  const before = fs.readFileSync(file);
  const stat = fs.statSync(file);
  assert.equal(scan(dir).code, 1);
  assert.deepEqual(fs.readFileSync(file), before, "the line is reported, never rewritten");
  assert.equal(fs.statSync(file).mtimeMs, stat.mtimeMs);
  assert.deepEqual(fs.readdirSync(dir), ["ankit.jsonl"], "and no file is added");
});

// --- the dispatch ----------------------------------------------------------

test("errorbook scan passes the folder argument through and returns the exit code", async () => {
  const calls = [];
  const ui = sink();
  const quiet = { interactive: false, async ask() { return ""; }, async yes() { return false; }, close() {} };
  const code = await runCli(["scan", "/some/dir"], {
    ui: createDisplay(ui.out, ui.err),
    prompts: quiet,
    scan: (deps) => { calls.push(deps); return 1; },
  });
  assert.equal(code, 1, "the scan's exit code is the command's exit code");
  assert.equal(calls[0].dir, "/some/dir");
  assert.ok(calls[0].ui, "the scan is handed the cli's display");

  // No argument: the scan falls back to the notebook folder itself.
  await runCli(["scan"], { ui: createDisplay(ui.out, ui.err), prompts: quiet, scan: (deps) => { calls.push(deps); return 0; } });
  assert.equal(calls[1].dir, null);
});

test("errorbook scan runs end to end against a real notebook folder", async () => {
  const dir = notebook({ "ankit.jsonl": line({ type: "solved", fix: `export KEY=${OPENAI_KEY}` }) });
  const ui = sink();
  const code = await runCli(["scan", dir], {
    ui: createDisplay(ui.out, ui.err),
    prompts: { interactive: false, async ask() { return ""; }, async yes() { return false; }, close() {} },
  });
  assert.equal(code, 1);
  const result = { stdout: ui.stdout(), stderr: ui.stderr() };
  leaks(result, OPENAI_KEY);
  assert.match(result.stderr, /ankit\.jsonl:1 fix /);
});

test("the usage text lists scan", async () => {
  const ui = sink();
  await runCli([], {
    ui: createDisplay(ui.out, ui.err),
    prompts: { interactive: false, async ask() { return ""; }, async yes() { return false; }, close() {} },
  });
  assert.match(ui.stderr(), /errorbook scan \[dir\]/);
});
