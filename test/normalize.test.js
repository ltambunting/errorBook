import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { normalize, fingerprint } from "../src/fingerprint/index.js";

test("normalizes stack traces across machines", () => {
  const a =
    "TypeError: failed\n    at fetchData (/Users/sam/project/api.js:47:12)";
  const b =
    "TypeError: failed\n    at fetchData (/home/priya/work/api.js:52:8)";

  assert.equal(normalize(a), normalize(b));
});

test("different missing scripts produce different fingerprints", () => {
  const build = fingerprint('npm error Missing script: "build"');
  const testScript = fingerprint('npm error Missing script: "test"');

  assert.notEqual(build.id, testScript.id);
});

test("handles an empty string", () => {
    assert.equal(normalize(""), "");
    assert.equal(fingerprint("").id, null);
  });
  
  test("handles whitespace-only input", () => {
    const result = normalize("   \n\t  ");
  
    assert.equal(typeof result, "string");
    assert.equal(result.trim(), "");
  });
  
  test("handles an error with surrounding whitespace", () => {
    const a = fingerprint("TypeError: failed");
    const b = fingerprint("  TypeError: failed  \n");
  
    assert.equal(a.id, b.id);
  });
  
  test("handles non-English error messages", () => {
    const result = fingerprint("Error: fichier introuvable");
  
    assert.ok(result.id);
    assert.equal(typeof result.id, "string");
  });
  
  test("handles very long error messages", () => {
    const message = "Error: something failed\n".repeat(1000);
    const result = fingerprint(message);
  
    assert.ok(result.id);
    assert.equal(typeof result.id, "string");
  });
  
  test("ignores line and column numbers in stack traces", () => {
    const a = fingerprint(
      "TypeError: failed\n    at fetchData (/app/api.js:47:12)"
    );
    const b = fingerprint(
      "TypeError: failed\n    at fetchData (/app/api.js:82:5)"
    );
  
    assert.equal(a.id, b.id);
  });

  test("different missing modules produce different fingerprints", () => {
    const express = fingerprint("Error: Cannot find module 'express'");
    const react = fingerprint("Error: Cannot find module 'react'");
  
    assert.notEqual(express.id, react.id);
  });

  test("different error types produce different fingerprints", () => {
    const typeError = fingerprint("TypeError: invalid value");
    const referenceError = fingerprint("ReferenceError: invalid value");
  
    assert.notEqual(typeError.id, referenceError.id);
  });

  test("ignores different process IDs in errors", () => {
    const a = fingerprint("Process 12345 failed: connection refused");
    const b = fingerprint("Process 67890 failed: connection refused");
  
    assert.equal(a.id, b.id);
  });

  test("different error messages produce different fingerprints", () => {
    const connection = fingerprint("Error: connection refused");
    const timeout = fingerprint("Error: request timed out");
  
    assert.notEqual(connection.id, timeout.id);
  });

  test("returns the expected fingerprint result structure", () => {
    const result = fingerprint("TypeError: invalid value");
  
    assert.ok(result.id);
    assert.ok(result.loose);
    assert.equal(typeof result.loose.lang, "string");
    assert.ok("errorType" in result.loose);
    assert.ok("file" in result.loose);
    assert.equal(typeof result.summary, "string");
  });
// --- summary line ----------------------------------------------------------
// The first line of a Node trace is the module banner, which tells a reader
// nothing. The summary should be the line carrying the error's type or code.

test("fb4768: the summary is the ERR_MODULE_NOT_FOUND line, not the node:internal banner", () => {
  const captured = fs.readFileSync(
    new URL("../samples/node-module-not-found-ankit.txt", import.meta.url), "utf8");
  const { id, summary } = fingerprint(captured);

  assert.equal(id, "fb4768", "the id must not move");
  assert.match(summary, /err_module_not_found/);
  assert.match(summary, /cannot find package 'express'/);
  assert.doesNotMatch(summary, /^node:internal/, "the banner is not a summary");
  assert.doesNotMatch(summary, /^throw /, "nor is the quoted source line");
  assert.ok(summary.length <= 120);
});

test("28b25a: the summary is the EADDRINUSE line, not the node:events banner", () => {
  // The real shape of a second `node server.js` against a taken port.
  const captured = [
    "node:events:502",
    "      throw er; // Unhandled 'error' event",
    "      ^",
    "",
    "Error: listen EADDRINUSE: address already in use :::3000",
    "    at Server.setupListenHandle [as _listen2] (node:net:1908:16)",
    "    at listenInCluster (node:net:1965:12)",
    "    at Server.listen (node:net:2067:7)",
    "Emitted 'error' event on Server instance at:",
    "    at emitErrorNT (node:net:1944:8) {",
    "  code: 'EADDRINUSE',",
    "  errno: -4091,",
    "  syscall: 'listen',",
    "  address: '::',",
    "  port: 3000",
    "}",
    "",
    "Node.js v22.17.0",
  ].join("\n");
  const { loose, summary } = fingerprint(captured);

  assert.equal(loose.errorType, "EADDRINUSE");
  assert.match(summary, /eaddrinuse/);
  assert.match(summary, /address already in use/);
  assert.doesNotMatch(summary, /^node:events/, "the banner is not a summary");
  assert.doesNotMatch(summary, /^code:/, "nor is the property dump");
});

test("npm and git summaries are unchanged: the first line was already right", () => {
  const npm = fingerprint(fs.readFileSync(
    new URL("../samples/npm-missing-script-ankit.txt", import.meta.url), "utf8"));
  assert.equal(npm.id, "6ce249");
  assert.equal(npm.summary, 'npm error missing script: "build"');

  // `fatal` names no particular failure, so it must not outrank the first line.
  // This is the real shape of the demo's git identity error, git's own commands
  // included -- they are also what tells detectLang this is git at all.
  const git = fingerprint([
    "Author identity unknown",
    "",
    "*** Please tell me who you are.",
    "",
    "Run",
    "",
    '  git config --global user.email "you@example.com"',
    '  git config --global user.name "Your Name"',
    "",
    "to set your account's default identity.",
    "Omit --global to set the identity only in this repository.",
    "",
    "fatal: empty ident name (for <>) not allowed",
  ].join("\n"));
  assert.equal(git.loose.errorType, "fatal");
  assert.equal(git.summary, "author identity unknown");
});

test("the summary falls back to the first line when nothing stands out", () => {
  assert.equal(fingerprint("Something went sideways\nand then stopped").summary, "something went sideways");
  // All noise: the first line is still better than nothing.
  assert.equal(fingerprint("node:events:1\n    at foo (node:net:1:1)").summary, "node:events:<n>");
  assert.equal(fingerprint("").summary, null);
});

test("choosing a summary cannot change an id", () => {
  // Same normalised text, so same hash, whichever line gets shown.
  for (const text of [
    fs.readFileSync(new URL("../samples/node-module-not-found-ankit.txt", import.meta.url), "utf8"),
    fs.readFileSync(new URL("../samples/npm-missing-script-ankit.txt", import.meta.url), "utf8"),
  ]) {
    const { id, summary } = fingerprint(text);
    assert.equal(id, createHash("sha256").update(normalize(text)).digest("hex").slice(0, 6));
    assert.equal(normalize(text).includes(summary), true, "the summary is a line of the normalised text");
  }
});

test("the git identity error is one id for everyone, whoever git names", () => {
  // Two-laptop mode leaves user.email set, so git's last line carries the
  // reader's own address. Unmasked, the same missing-identity error got a
  // different id on every machine, and the shipped explanation never matched.
  const identity = (ident) => [
    "Author identity unknown",
    "",
    "*** Please tell me who you are.",
    "",
    "Run",
    "",
    '  git config --global user.email "you@example.com"',
    '  git config --global user.name "Your Name"',
    "",
    "to set your account's default identity.",
    "Omit --global to set the identity only in this repository.",
    "",
    `fatal: empty ident name (for <${ident}>) not allowed`,
  ].join("\n");

  const ids = ["", "ankit@example.com", "louisa@example.com", "someone.else@corp.internal"]
    .map((who) => fingerprint(identity(who)).id);
  assert.equal(new Set(ids).size, 1, `ids diverged: ${ids.join(", ")}`);

  assert.match(normalize(identity("a@b.com")), /\(for <who>\) not allowed/);
  assert.match(normalize(identity("")), /\(for <who>\) not allowed/);
  // The address is gone from the fingerprinted text entirely.
  assert.doesNotMatch(normalize(identity("a@b.com")), /a@b\.com/);
  // And the summary is still the readable first line.
  assert.equal(fingerprint(identity("a@b.com")).summary, "author identity unknown");
});

test("masking the identity does not swallow ordinary prose", () => {
  // Only `(for <...>)` is masked, not every angle bracket.
  assert.match(normalize("waiting for <something> to finish"), /waiting for <something> to finish/);
  assert.match(normalize("Expected <div> but found <span>"), /expected <div> but found <span>/);
});
