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