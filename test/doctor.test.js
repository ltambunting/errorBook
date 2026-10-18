// Covers `errorbook doctor`. Every check takes its filesystem, Node version,
// git config and port probe from an injected deps bag, so the cases here run
// against fixture folders and stubs: no real port is taken, no git config is
// read, and nothing is installed or written.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { Writable } from "node:stream";
import { runCli } from "../src/cli/cli.js";
import { createDisplay } from "../src/cli/display.js";
import {
  runDoctor,
  minMajor,
  envKeys,
  checkNode,
  checkEnv,
  checkPort,
  checkGit,
  checkDeps,
  checkNotebook,
  probePort,
} from "../src/doctor/index.js";

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

// A throwaway project folder. `files` maps a relative path to its contents; a
// path ending in "/" is made as an empty directory.
const temps = [];
function project(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "errorbook-doctor-"));
  temps.push(root);
  for (const [name, body] of Object.entries(files)) {
    const target = path.join(root, name);
    if (name.endsWith("/")) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  }
  return root;
}
after(() => {
  for (const root of temps) fs.rmSync(root, { recursive: true, force: true });
});

function sink(isTTY = false) {
  const out = [], err = [];
  const stream = (bucket) => {
    const s = new Writable({ write(c, e, cb) { bucket.push(c.toString()); cb(); } });
    s.isTTY = isTTY;
    return s;
  };
  return { out: stream(out), err: stream(err), stdout: () => out.join(""), stderr: () => err.join("") };
}

// Real listeners, on ports the OS hands out. Port 0 means "any free port",
// so these never collide with a port a developer is actually serving on, and
// never touch 3000.
const listeners = [];
function wildcardListener(host) {
  const server = net.createServer();
  listeners.push(server);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    // No host is the dual-stack wildcard, which is how a dev server binds and
    // what made the loopback-only bind lie.
    server.listen(host === undefined ? { port: 0 } : { port: 0, host }, () => {
      resolve({
        port: server.address().port,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

// A port that was free a moment ago: bound to get a number out of the OS, then
// released. Inherently a snapshot, but on an ephemeral port nothing else is
// racing for it.
function freeEphemeralPort() {
  return wildcardListener().then(({ port, close }) => close().then(() => port));
}

after(async () => {
  for (const server of listeners) {
    if (server.listening) await new Promise((done) => server.close(done));
  }
});

const freePort = async () => ({ free: true, code: null });
const takenPort = async () => ({ free: false, code: "EADDRINUSE" });
const gitSet = (key) => (key === "user.name" ? "Ankit Aggarwal" : "ankit@example.com");
const gitEmpty = () => "";

// A deps bag over a fixture root, with everything that would touch the real
// machine stubbed to a known answer.
const bag = (root, over = {}) => ({
  fs,
  root,
  nodeVersion: "v22.4.0",
  notebookDir: path.join(root, ".errorbook"),
  gitConfig: gitSet,
  probePort: freePort,
  ...over,
});

// --- helpers ---------------------------------------------------------------

test("minMajor reads the major out of every range shape the field is written in", () => {
  assert.equal(minMajor(">=20"), 20);
  assert.equal(minMajor(">=20.11.1"), 20);
  assert.equal(minMajor("^20.0.0"), 20);
  assert.equal(minMajor("20.x"), 20);
  assert.equal(minMajor("v22.4.0"), 22);
  // No number to read, and no guess invented.
  assert.equal(minMajor("*"), null);
  assert.equal(minMajor(undefined), null);
});

test("envKeys takes names and skips comments, blanks and junk", () => {
  const keys = envKeys("# a comment\nAPI_KEY=secret-value\n\nexport PORT=4000\nEMPTY=\nnot a key line\n");
  assert.deepEqual([...keys.keys()], ["API_KEY", "PORT", "EMPTY"]);
  assert.equal(keys.get("PORT"), "4000");
  assert.equal(keys.get("EMPTY"), "", "a declared-but-unset key is empty, not absent");
});

// --- 1. node version -------------------------------------------------------

test("a Node older than engines.node fails and names the version to install", () => {
  const root = project({ "package.json": JSON.stringify({ engines: { node: ">=20" } }) });
  const result = checkNode(bag(root, { nodeVersion: "v18.19.0" }));
  assert.equal(result.status, "fail");
  assert.match(result.detail, /v18\.19\.0/);
  assert.match(result.fix, /Node 20 or newer/);
});

test("a Node that satisfies engines.node is ok", () => {
  const root = project({ "package.json": JSON.stringify({ engines: { node: ">=20" } }) });
  assert.equal(checkNode(bag(root)).status, "ok");
});

test("a .nvmrc naming another major warns even when engines.node is satisfied", () => {
  const root = project({
    "package.json": JSON.stringify({ engines: { node: ">=20" } }),
    ".nvmrc": "20.11.1\n",
  });
  const result = checkNode(bag(root, { nodeVersion: "v22.4.0" }));
  assert.equal(result.status, "warn");
  assert.match(result.detail, /\.nvmrc asks for 20/);
  assert.match(result.fix, /nvm use/);
});

test("a missing engines.node warns, and unparseable package.json does not throw", () => {
  assert.equal(checkNode(bag(project({ "package.json": "{}" }))).status, "warn");
  const broken = checkNode(bag(project({ "package.json": "{ not json" })));
  assert.equal(broken.status, "warn");
  assert.match(broken.detail, /not valid JSON/);
});

// --- 2. env keys -----------------------------------------------------------

test("keys missing from .env fail, listing names only and never values", () => {
  const root = project({
    ".env.example": "API_KEY=\nPORT=3000\nDEBUG=\n",
    ".env": "PORT=3000\n",
  });
  const result = checkEnv(bag(root));
  assert.equal(result.status, "fail");
  assert.match(result.detail, /API_KEY/);
  assert.match(result.detail, /DEBUG/);
  assert.doesNotMatch(result.detail, /3000/, "no value from either file is printed");
});

test("a missing .env fails and lists what the example declares", () => {
  const root = project({ ".env.example": "API_KEY=please-replace-me\n" });
  const result = checkEnv(bag(root));
  assert.equal(result.status, "fail");
  assert.match(result.detail, /API_KEY/);
  assert.doesNotMatch(result.detail, /please-replace-me/, "the example's own value stays out of the report");
});

test("a key present but empty in .env warns rather than failing", () => {
  const root = project({ ".env.example": "API_KEY=x\n", ".env": "API_KEY=\n" });
  const result = checkEnv(bag(root));
  assert.equal(result.status, "warn");
  assert.match(result.detail, /API_KEY/);
});

test("every declared key supplied is ok, and no .env.example at all is ok", () => {
  const supplied = project({ ".env.example": "API_KEY=x\n", ".env": "API_KEY=real\n" });
  const result = checkEnv(bag(supplied));
  assert.equal(result.status, "ok");
  assert.doesNotMatch(result.detail, /real/, "a supplied value is never echoed");
  assert.equal(checkEnv(bag(project({}))).status, "ok");
});

// --- 3. port ---------------------------------------------------------------

test("the port comes from PORT in .env.example, and a bound port warns", async () => {
  const root = project({ ".env.example": "PORT=4100\n" });
  const asked = [];
  const result = await checkPort(bag(root, {
    probePort: async (port) => { asked.push(port); return { free: false, code: "EADDRINUSE" }; },
  }));
  assert.deepEqual(asked, [4100], "the declared port is the one probed");
  assert.equal(result.status, "warn");
  assert.match(result.detail, /4100 is already in use/);
});

test("without a declared PORT the check falls back to 3000 and reports it free", async () => {
  const asked = [];
  const result = await checkPort(bag(project({}), {
    probePort: async (port) => { asked.push(port); return { free: true, code: null }; },
  }));
  assert.deepEqual(asked, [3000]);
  assert.equal(result.status, "ok");
  assert.match(result.detail, /3000 is free/);
});

test("the real probe releases the port, so two runs in a row both report it free", async () => {
  // The one case with no probe stub: it is what proves the bind is handed back
  // rather than left holding the port the project is about to serve on.
  const port = await freeEphemeralPort();
  const root = project({
    "package.json": JSON.stringify({ engines: { node: ">=20" } }),
    ".env.example": `PORT=${port}\n`,
    ".env": `PORT=${port}\n`,
    "package-lock.json": "{}",
    "node_modules/": "",
  });
  const ui = sink();
  const deps = bag(root, { ui: createDisplay(ui.out, ui.err) });
  delete deps.probePort; // let runDoctor supply the real one
  assert.equal(await runDoctor(deps), 0);
  assert.equal(await runDoctor(deps), 0);
  assert.equal(ui.stdout().match(new RegExp(`port: ${port} is free`, "g"))?.length, 2);
});

// --- 3b. the real probe against a real listener ---------------------------

test("a listener on the wildcard address reports busy, not free", async () => {
  // The bug this covers: on Windows a bind to 127.0.0.1 succeeds while another
  // process holds the same port on 0.0.0.0 / [::], so a loopback-only bind
  // called an occupied port free. The listener here is bound the way a dev
  // server binds it -- the wildcard, by omitting the host.
  const { port, close } = await wildcardListener();
  try {
    const result = await probePort(port);
    assert.equal(result.free, false, "a port with a wildcard listener on it is not free");
    assert.equal(result.code, "EADDRINUSE");
  } finally {
    await close();
  }
});

test("checkPort reports the wildcard-held port from .env.example as in use", async () => {
  const { port, close } = await wildcardListener();
  try {
    const root = project({ ".env.example": `PORT=${port}\n` });
    const deps = bag(root);
    delete deps.probePort; // the real probe, against the real listener
    const result = await checkPort(deps);
    assert.equal(result.status, "warn");
    assert.match(result.detail, new RegExp(`${port} is already in use`));
    assert.match(result.fix, /set PORT to a free port/);
  } finally {
    await close();
  }
});

test("the real probe reports an ephemeral port nobody holds as free", async () => {
  const port = await freeEphemeralPort();
  const result = await probePort(port);
  assert.equal(result.free, true);
  assert.equal(result.code, null);
});

test("a listener bound only to loopback is still reported busy", async () => {
  // The other direction: the connect attempt answers on 127.0.0.1 even though
  // nothing holds the wildcard.
  const { port, close } = await wildcardListener("127.0.0.1");
  try {
    assert.equal((await probePort(port)).free, false);
  } finally {
    await close();
  }
});

// --- 4. git identity -------------------------------------------------------

test("an empty git identity warns and names the config command", () => {
  const result = checkGit({ gitConfig: gitEmpty });
  assert.equal(result.status, "warn");
  assert.match(result.detail, /user\.name and user\.email are empty/);
  assert.match(result.fix, /git config user\.name/);
});

test("a set git identity is ok", () => {
  assert.equal(checkGit({ gitConfig: gitSet }).status, "ok");
});

// --- 5. node_modules vs the lockfile --------------------------------------

test("a missing node_modules fails", () => {
  const root = project({ "package-lock.json": "{}" });
  const result = checkDeps(bag(root));
  assert.equal(result.status, "fail");
  assert.match(result.fix, /npm install/);
});

test("node_modules older than the lockfile warns", () => {
  const root = project({ "node_modules/": "", "package-lock.json": "{}" });
  const old = Date.now() - 60_000;
  fs.utimesSync(path.join(root, "node_modules"), old / 1000, old / 1000);
  const result = checkDeps(bag(root));
  assert.equal(result.status, "warn");
  assert.match(result.detail, /older than package-lock\.json/);
});

test("node_modules newer than the lockfile is ok", () => {
  const root = project({ "package-lock.json": "{}", "node_modules/": "" });
  const old = Date.now() - 60_000;
  fs.utimesSync(path.join(root, "package-lock.json"), old / 1000, old / 1000);
  assert.equal(checkDeps(bag(root)).status, "ok");
});

// --- 6. the notebook -------------------------------------------------------

test("a readable notebook with sound lines is ok", () => {
  const root = project({
    ".errorbook/ankit.jsonl": '{"type":"solved","fingerprint":"6ce249"}\n{"type":"confirmed","fingerprint":"6ce249"}\n',
  });
  const result = checkNotebook(bag(root));
  assert.equal(result.status, "ok");
  assert.match(result.detail, /2 lines/);
});

test("corrupt lines warn with file and line numbers, never their contents", () => {
  const root = project({
    ".errorbook/ankit.jsonl": '{"type":"solved"}\n{ broken json\n42\n{"type":"confirmed"}\n',
  });
  const result = checkNotebook(bag(root));
  assert.equal(result.status, "warn");
  assert.match(result.detail, /ankit\.jsonl:2/);
  assert.match(result.detail, /ankit\.jsonl:3/, '"42" parses but is not an event');
  assert.doesNotMatch(result.detail, /broken json/, "the line's text stays out of the report");
});

test("a notebook folder that does not exist yet is ok, not a failure", () => {
  assert.equal(checkNotebook(bag(project({}))).status, "ok");
});

test("a notebook folder that cannot be read fails", () => {
  const root = project({});
  const result = checkNotebook({
    ...bag(root),
    fs: { readdirSync() { const e = new Error("denied"); e.code = "EACCES"; throw e; } },
  });
  assert.equal(result.status, "fail");
  assert.match(result.detail, /EACCES/);
});

// --- the report ------------------------------------------------------------

test("a clean project reports every check ok and exits 0", async () => {
  const root = project({
    "package.json": JSON.stringify({ engines: { node: ">=20" } }),
    "package-lock.json": "{}",
    "node_modules/": "",
  });
  const ui = sink();
  const code = await runDoctor(bag(root, { ui: createDisplay(ui.out, ui.err) }));
  assert.equal(code, 0);
  const report = ui.stdout();
  assert.match(report, /6 checks: 6 ok, 0 warnings, 0 failures/);
  assert.equal(ui.stderr(), "", "nothing goes to stderr when nothing failed");
  for (const name of ["node", "env", "port", "git", "deps", "notebook"]) {
    assert.match(report, new RegExp(`ok\\s+${name}:`), `${name} is reported`);
  }
  // eslint-disable-next-line no-control-regex -- asserting the absence of them
  assert.doesNotMatch(report, /[^\x09\x0a\x20-\x7e]/, "the report is ASCII only");
});

test("a failing check sends its line and its fix to stderr and exits 1", async () => {
  const root = project({
    "package.json": JSON.stringify({ engines: { node: ">=20" } }),
    ".env.example": "API_KEY=x\n",
    "package-lock.json": "{}",
    "node_modules/": "",
  });
  const ui = sink();
  const code = await runDoctor(bag(root, { ui: createDisplay(ui.out, ui.err), gitConfig: gitEmpty, probePort: takenPort }));
  assert.equal(code, 1, "a failed check exits 1");
  assert.match(ui.stderr(), /fail\s+env: \.env is missing/);
  assert.match(ui.stderr(), /fix: /, "the fix travels with the failure");
  // The warnings are results, not errors, so they stay on stdout.
  assert.match(ui.stdout(), /warn\s+git:/);
  assert.match(ui.stdout(), /warn\s+port:/);
  assert.match(ui.stdout(), /6 checks: \d+ ok, 2 warnings, 1 failure/);
});

test("warnings alone do not fail the command", async () => {
  const root = project({ "package.json": "{}", "package-lock.json": "{}", "node_modules/": "" });
  const ui = sink();
  const code = await runDoctor(bag(root, { ui: createDisplay(ui.out, ui.err), gitConfig: gitEmpty }));
  assert.equal(code, 0);
  assert.match(ui.stdout(), /0 failures/);
});

test("NO_COLOR and a non-tty report carry no escape sequences", async () => {
  const root = project({ "package.json": JSON.stringify({ engines: { node: ">=20" } }), "node_modules/": "" });
  const ui = sink(true); // a tty, so only NO_COLOR can keep the colour out
  const previous = process.env.NO_COLOR;
  process.env.NO_COLOR = "1";
  try {
    await runDoctor(bag(root, { ui: createDisplay(ui.out, ui.err) }));
  } finally {
    if (previous === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previous;
  }
  assert.doesNotMatch(ui.stdout(), /\x1b\[/);
});

// --- the dispatch ----------------------------------------------------------

test("errorbook doctor runs the doctor and returns its exit code", async () => {
  const ui = sink();
  const calls = [];
  const code = await runCli(["doctor"], {
    ui: createDisplay(ui.out, ui.err),
    prompts: { interactive: false, async ask() { return ""; }, async yes() { return false; }, close() {} },
    doctor: async (deps) => { calls.push(deps); return 1; },
  });
  assert.equal(code, 1, "the doctor's exit code is the command's exit code");
  assert.equal(calls.length, 1);
  assert.ok(calls[0].ui, "the doctor is handed the cli's display, so output is routed the same way");
});

test("the usage text lists doctor", async () => {
  const ui = sink();
  await runCli([], {
    ui: createDisplay(ui.out, ui.err),
    prompts: { interactive: false, async ask() { return ""; }, async yes() { return false; }, close() {} },
  });
  assert.match(ui.stderr(), /errorbook doctor/);
});
