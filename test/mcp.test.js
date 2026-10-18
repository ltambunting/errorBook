// Covers `errorbook mcp`: the notebook served to coding agents over stdio.
//
// The protocol cases run against a real spawned server, because the things
// most likely to break a stdio server are exactly the things an in-process
// call cannot show: a stray write to stdout, a line that does not parse, a
// process that hangs instead of exiting when the client goes away. The message
// handler and the plain-English sentence are also tested directly, where the
// assertions can be precise.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { append } from "../src/memory/index.js";
import { handleMessage, callTool, sentence } from "../src/mcp/index.js";
import { contextFromFailure } from "../src/explainer/context.js";

// Nothing here may depend on the caller's shell -- and the spawned server
// inherits this environment, so clearing these also keeps the child off a
// developer's real notebook. Cleared first, pointed at a temp folder,
// restored at the end.
const INHERITED = ["ERRORBOOK_DIR", "ERRORBOOK_AUTHOR", "ERRORBOOK_AUTHOR_NAME", "ERRORBOOK_AUTHOR_EMAIL"];
const callerEnv = Object.fromEntries(INHERITED.map((key) => [key, process.env[key]]));
for (const key of INHERITED) delete process.env[key];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "errorbook-mcp-"));
process.env.ERRORBOOK_DIR = dir;

after(() => {
  for (const key of INHERITED) {
    if (callerEnv[key] === undefined) delete process.env[key];
    else process.env[key] = callerEnv[key];
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

const BIN = fileURLToPath(new URL("../bin/errorbook.js", import.meta.url));
const sample = (name) => fs.readFileSync(new URL(`../samples/${name}`, import.meta.url), "utf8");
const NPM_BUILD = sample("npm-missing-script-ankit.txt");              // 6ce249
const NPM_OTHER = sample("npm-missing-script-doesnotexist-ankit.txt");  // e73c44, loose-matches 6ce249
const NODE_MISSING = sample("node-module-not-found-ankit.txt");         // fb4768

const DAY = 86400000;
const daysAgo = (d) => new Date(Date.now() - d * DAY).toISOString();

// The notebook the agent gets to consult: one fix by Louisa, confirmed by one
// teammate, plus a second fix so there is an alternative to report.
let saved;
before(() => {
  saved = append({
    type: "solved",
    fingerprint: "6ce249",
    fix: "Add a build script to package.json",
    author: "louisa-tambunting",
    summary: 'npm error missing script: "build"',
    loose: { lang: "npm", errorType: "missing-script", file: null },
    ts: daysAgo(3),
  });
  append({
    type: "solved", fingerprint: "6ce249", fix: "Reinstall node_modules",
    author: "sam-reed", loose: { lang: "npm", errorType: "missing-script", file: null }, ts: daysAgo(2),
  });
  append({ type: "confirmed", fingerprint: "6ce249", fixId: saved.fixId, author: "ankit-aggarwal", ts: daysAgo(1) });
});

// Runs a real server: writes each line, closes stdin, waits for it to exit.
// Returns every stdout line parsed, plus whatever went to stderr.
function serve(lines) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, "mcp"], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", reject);
    child.on("close", (code) => {
      const raw = out.split("\n").filter((l) => l.trim());
      let messages;
      try {
        messages = raw.map((l) => JSON.parse(l));
      } catch (error) {
        reject(new Error(`stdout was not one JSON message per line: ${error.message}\n${out}`));
        return;
      }
      resolve({ code, out, err, raw, messages });
    });
    for (const line of lines) {
      child.stdin.write(`${typeof line === "string" ? line : JSON.stringify(line)}\n`);
    }
    child.stdin.end();
  });
}

const rpc = (id, method, params) => ({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
const call = (id, error_text) => rpc(id, "tools/call", { name: "errorbook_lookup", arguments: { error_text } });
// The tool returns one text block: a sentence, a blank line, then the JSON.
const payload = (message) => JSON.parse(message.result.content[0].text.split("\n\n").slice(1).join("\n\n"));
const firstLine = (message) => message.result.content[0].text.split("\n")[0];

// --- the handshake and the catalogue --------------------------------------

test("initialize echoes the protocol version and names the server", async () => {
  const { messages, code } = await serve([
    rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } }),
  ]);
  assert.equal(code, 0, "the server exits cleanly when stdin closes");
  assert.equal(messages.length, 1);
  const [reply] = messages;
  assert.equal(reply.jsonrpc, "2.0");
  assert.equal(reply.id, 1);
  assert.equal(reply.result.protocolVersion, "2025-06-18", "the client's own version is echoed");
  assert.deepEqual(reply.result.capabilities, { tools: {} });
  assert.equal(reply.result.serverInfo.name, "errorbook");
  assert.ok(reply.result.serverInfo.version);
});

test("notifications/initialized is not answered", async () => {
  const { messages } = await serve([
    rpc(1, "initialize", { protocolVersion: "2024-11-05" }),
    { jsonrpc: "2.0", method: "notifications/initialized" },
    rpc(2, "ping"),
  ]);
  // Two requests, two replies: the notification in between got none.
  assert.deepEqual(messages.map((m) => m.id), [1, 2]);
  assert.deepEqual(messages[1].result, {}, "ping answers with an empty result");
});

test("tools/list offers exactly one read-only lookup tool", async () => {
  const { messages } = await serve([rpc(1, "tools/list")]);
  const { tools } = messages[0].result;
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "errorbook_lookup");
  assert.match(tools[0].description, /[Rr]ead-only/);
  assert.deepEqual(tools[0].inputSchema.required, ["error_text"]);
  assert.equal(tools[0].inputSchema.properties.error_text.type, "string");
});

// --- the tool -------------------------------------------------------------

test("a hit answers in plain English first, then the lookup --json document", async () => {
  const { messages } = await serve([call(1, NPM_BUILD)]);
  const [reply] = messages;
  assert.equal(reply.result.isError, undefined, "a miss or a hit is an answer, not a tool failure");

  assert.match(firstLine(reply), /^Louisa fixed this 3 days ago, confirmed by 1 teammate\./);
  const data = payload(reply);
  assert.deepEqual(Object.keys(data), ["kind", "errorId", "summary", "fix", "alternatives"]);
  assert.equal(data.kind, "exact");
  assert.equal(data.errorId, "6ce249");
  assert.equal(data.fix.fix, "Add a build script to package.json");
  assert.equal(data.fix.author, "louisa-tambunting");
  assert.equal(data.fix.confirmations, 1);
  assert.equal(data.alternatives.length, 1);
});

test("a loose hit says so in the first line", async () => {
  const { messages } = await serve([call(1, NPM_OTHER)]);
  assert.match(firstLine(messages[0]), /^Similar error, not an exact match -- verify it applies\./);
  const data = payload(messages[0]);
  assert.equal(data.kind, "loose");
  assert.equal(data.errorId, "e73c44", "the id is the asked-about error's own");
});

test("a miss says so plainly and still returns the document", async () => {
  const { messages } = await serve([call(1, NODE_MISSING)]);
  assert.equal(firstLine(messages[0]), "No known fix in the team notebook.");
  const data = payload(messages[0]);
  assert.equal(data.kind, "none");
  assert.equal(data.fix, null);
  assert.deepEqual(data.alternatives, []);
});

test("error_text is capped at 64KB, and it is the capped text that is answered", async () => {
  const huge = `${NPM_BUILD}\n${"filler log line\n".repeat(5000)}`;
  assert.ok(huge.length > 64 * 1024, "the fixture really is oversize");

  const { messages, out } = await serve([call(1, huge)]);
  const reply = messages[0];
  assert.match(firstLine(reply), /the error text was truncated to 64KB/);
  assert.ok(out.length < 16 * 1024, "the reply is bounded, whatever came in");

  // The cap is exact: the id is the one the first 64KB fingerprints to, and not
  // the one the whole thing would give. Trailing log changes the fingerprint
  // either way, which is why a caller should send the error and not the log.
  const capped = contextFromFailure({ stderr: huge.slice(0, 64 * 1024) }).errorId;
  const whole = contextFromFailure({ stderr: huge }).errorId;
  assert.notEqual(capped, whole, "the two differ, so this assertion means something");
  assert.equal(payload(reply).errorId, capped);
});

test("a tool call with no error_text is a tool error, not a protocol error", async () => {
  const { messages } = await serve([
    rpc(1, "tools/call", { name: "errorbook_lookup", arguments: {} }),
    rpc(2, "tools/call", { name: "errorbook_lookup", arguments: { error_text: "   " } }),
  ]);
  for (const reply of messages) {
    assert.equal(reply.error, undefined, "the agent gets something it can act on");
    assert.equal(reply.result.isError, true);
    assert.match(reply.result.content[0].text, /needs error_text/);
  }
});

test("an unknown tool name is rejected as an invalid parameter", async () => {
  const { messages } = await serve([rpc(1, "tools/call", { name: "errorbook_write", arguments: {} })]);
  assert.equal(messages[0].error.code, -32602);
  assert.match(messages[0].error.message, /Unknown tool: errorbook_write/);
});

// --- the protocol's edges -------------------------------------------------

test("an unknown method is -32601", async () => {
  const { messages } = await serve([rpc(7, "resources/list")]);
  assert.equal(messages[0].id, 7);
  assert.equal(messages[0].error.code, -32601);
  assert.match(messages[0].error.message, /Method not found/);
});

test("malformed JSON is -32700 with a null id, and the server keeps going", async () => {
  const { messages, code } = await serve([
    "{ not json at all",
    "",
    "   ",
    rpc(2, "ping"),
  ]);
  assert.equal(code, 0);
  assert.equal(messages.length, 2, "blank lines are not messages");
  assert.equal(messages[0].id, null);
  assert.equal(messages[0].error.code, -32700);
  assert.deepEqual(messages[1], { jsonrpc: "2.0", id: 2, result: {} }, "the next request is still served");
});

test("a JSON value that is not a request object is -32600", async () => {
  const { messages } = await serve(["42", "[]", "null", rpc(3, "ping")]);
  assert.deepEqual(messages.slice(0, 3).map((m) => m.error.code), [-32600, -32600, -32600]);
  assert.equal(messages[3].id, 3);
});

test("several requests on one write are each answered, in order", async () => {
  // A client is free to send a burst; the server must split on newlines rather
  // than assume one message per read.
  const { messages } = await serve([rpc(1, "initialize", {}), rpc(2, "tools/list"), call(3, NPM_BUILD), rpc(4, "ping")]);
  assert.deepEqual(messages.map((m) => m.id), [1, 2, 3, 4]);
});

test("stdout carries only protocol, and logs go to stderr", async () => {
  const { raw, err } = await serve([
    "{ not json",
    rpc(1, "initialize", {}),
    call(2, NPM_BUILD),
  ]);
  // Every stdout line is a JSON-RPC message and nothing else.
  for (const line of raw) {
    const message = JSON.parse(line);
    assert.equal(message.jsonrpc, "2.0", `not a protocol message: ${line}`);
    assert.ok("result" in message || "error" in message);
  }
  assert.ok(!err.includes("{\"jsonrpc\""), "no protocol on stderr either");
});

test("the server exits cleanly on stdin close even mid-conversation", async () => {
  const { code, messages } = await serve([rpc(1, "initialize", {})]);
  assert.equal(code, 0);
  assert.equal(messages.length, 1);
});

// --- read-only ------------------------------------------------------------

test("the notebook is byte-identical after a whole session", async () => {
  const snapshot = fs.readdirSync(dir).sort().map((name) => {
    const file = path.join(dir, name);
    return { name, bytes: fs.readFileSync(file).toString("hex"), mtimeMs: fs.statSync(file).mtimeMs };
  });

  await serve([
    rpc(1, "initialize", {}),
    { jsonrpc: "2.0", method: "notifications/initialized" },
    rpc(2, "tools/list"),
    call(3, NPM_BUILD),
    call(4, NPM_OTHER),
    call(5, NODE_MISSING),
    rpc(6, "tools/call", { name: "errorbook_lookup", arguments: { error_text: "Error: write a line to the notebook" } }),
  ]);

  const after_ = fs.readdirSync(dir).sort().map((name) => {
    const file = path.join(dir, name);
    return { name, bytes: fs.readFileSync(file).toString("hex"), mtimeMs: fs.statSync(file).mtimeMs };
  });
  assert.deepEqual(after_, snapshot, "no line appended, no file added, nothing touched");
});

// --- the message handler, directly ----------------------------------------

test("handleMessage never answers a notification, whatever the method", () => {
  for (const method of ["notifications/initialized", "ping", "tools/list", "nonsense/method"]) {
    assert.equal(handleMessage({ jsonrpc: "2.0", method }), null, method);
  }
});

test("handleMessage reports a request with no method as -32600", () => {
  assert.equal(handleMessage({ jsonrpc: "2.0", id: 1 }).error.code, -32600);
  assert.equal(handleMessage({ jsonrpc: "2.0", id: 1, method: 42 }).error.code, -32600);
});

test("handleMessage turns an unexpected failure into -32603 rather than throwing", () => {
  const logged = [];
  const exploding = { lookup() { throw new Error("the notebook is on fire"); } };
  const reply = handleMessage(
    { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "errorbook_lookup", arguments: { error_text: "TypeError: x" } } },
    { book: exploding, log: (text) => logged.push(text) },
  );
  assert.equal(reply.error.code, -32603);
  assert.equal(reply.error.message, "Internal error", "no internals in the wire message");
  assert.match(logged.join(" "), /the notebook is on fire/, "the detail goes to the log instead");
});

test("initialize without a protocolVersion falls back to the one we implement", () => {
  const reply = handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  assert.match(reply.result.protocolVersion, /^\d{4}-\d{2}-\d{2}$/);
});

// --- the sentence ---------------------------------------------------------

const found = (over = {}) => ({
  found: true,
  kind: "exact",
  json: {
    fix: { author: "louisa-tambunting", age: "3 days ago", confirmations: 1, returned: false, ...(over.fix ?? {}) },
    alternatives: over.alternatives ?? [],
  },
  ...(over.kind ? { kind: over.kind } : {}),
});

test("the sentence reads as English for each shape of answer", () => {
  assert.equal(sentence(found()), "Louisa fixed this 3 days ago, confirmed by 1 teammate.");
  assert.equal(sentence(found({ fix: { confirmations: 3 } })), "Louisa fixed this 3 days ago, confirmed by 3 teammates.");
  assert.equal(sentence(found({ fix: { confirmations: 0 } })), "Louisa fixed this 3 days ago, not yet confirmed by anyone else.");
  assert.match(sentence(found({ fix: { returned: true } })), /the error has since come back/);
  assert.match(sentence(found({ alternatives: [{}, {}] })), /2 other fixes are on record\./);
  assert.match(sentence(found({ alternatives: [{}] })), /1 other fix is on record\./);
  assert.match(sentence(found({ kind: "loose" })), /^Similar error, not an exact match/);
});

test("a miss and a truncation are both stated plainly", () => {
  assert.equal(sentence(null), "No known fix in the team notebook.");
  assert.equal(sentence({ found: false }), "No known fix in the team notebook.");
  assert.match(sentence(null, { truncated: true }), /truncated to 64KB/);
});

test("the sentence is ASCII even when the notebook is not", () => {
  const text = sentence(found({ fix: { author: "café-owner\nx", age: "1 day ago" } }));
  // eslint-disable-next-line no-control-regex -- asserting the absence of them
  assert.doesNotMatch(text, /[^\x20-\x7e]/);
});

// --- the tool function, directly ------------------------------------------

test("callTool never reaches for the notebook when the input is unusable", () => {
  const book = { lookup() { throw new Error("should not be asked"); } };
  const outcome = callTool("errorbook_lookup", { error_text: "" }, { book });
  assert.equal(outcome.result.isError, true);
});

test("callTool on text with nothing fingerprintable reports a miss, not a crash", () => {
  const outcome = callTool("errorbook_lookup", { error_text: "   \n\t " }, { book: { lookup() { throw new Error("no"); } } });
  assert.equal(outcome.result.isError, true, "whitespace is no error text at all");
});
