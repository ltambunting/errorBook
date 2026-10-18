import test from "node:test";
import assert from "node:assert/strict";
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