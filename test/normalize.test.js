
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeError } from "../fingerprint/normalize.js";

test("converts error text to lowercase", () => {
  assert.equal(
    normalizeError("TypeError: SOMETHING BROKE"),
    "typeerror: something broke"
  );
});

test("normalizes stack traces from different machines", () => {
  const errorA = `TypeError: Cannot read properties of undefined (reading 'map')
    at fetchData (/Users/sam/project/api.js:47:12)`;

  const errorB = `TypeError: Cannot read properties of undefined (reading 'map')
    at fetchData (/home/priya/work/api.js:52:8)`;

  assert.equal(normalizeError(errorA), normalizeError(errorB));
});

test("ignores differences in npm debug-log paths", () => {
  const errorA = `npm error Missing script: "doesnotexist"
npm error A complete log of this run can be found in: C:\\Users\\ankit\\AppData\\Local\\npm-cache\\_logs\\2026-10-17T23_27_48_007Z-debug-0.log`;

  const errorB = `npm error Missing script: "doesnotexist"
npm error A complete log of this run can be found in: C:\\Users\\louis\\AppData\\Local\\npm-cache\\_logs\\2026-10-18T10_15_32_123Z-debug-0.log`;

  assert.equal(normalizeError(errorA), normalizeError(errorB));
});

test("preserves meaningful error differences", () => {
  const missingScript = 'npm error Missing script: "doesnotexist"';
  const missingPackage = "npm error code ENOENT\nnpm error enoent Could not read package.json";

  assert.notEqual(
    normalizeError(missingScript),
    normalizeError(missingPackage)
  );
});

test("rejects non-string input", () => {
  assert.throws(
    () => normalizeError(null),
    TypeError
  );
});