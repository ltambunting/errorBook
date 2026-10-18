import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { append, loadAll, lookup, scrub } from "../src/memory/index.js";
import { confidence } from "../src/memory/tally.js";

// Every test gets its own empty notebook folder.
beforeEach(() => {
  process.env.ERRORBOOK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "eb-"));
});

// The three starter lines from the spec.
const STARTER = [
  {"v":1,"type":"solved","fingerprint":"6ce249","fixId":"84282f50","loose":{"lang":"npm","errorType":"missing-script","file":null},"summary":"npm error missing script: \"build\"","raw":"npm error Missing script: \"build\"","fix":"Add a build script to package.json","author":"ankit","ts":"2026-10-18T00:21:07Z","versions":{"node":"22.17.0"},"timeToSolve":180},
  {"v":1,"type":"solved","fingerprint":"6ce249","fixId":"21ecc490","loose":{"lang":"npm","errorType":"missing-script","file":null},"summary":"npm error missing script: \"build\"","raw":"npm error Missing script: \"build\"","fix":"Reinstall node_modules","author":"louisa","ts":"2026-10-18T00:40:00Z","versions":{"node":"22.17.0"},"timeToSolve":600},
  {"v":1,"type":"confirmed","fingerprint":"6ce249","fixId":"84282f50","author":"louis","ts":"2026-10-18T01:14:00Z"},
];
const writeStarter = () => STARTER.forEach((line) => append(line));

test("append writes to the author's own lowercase file; loadAll reads everyone's", () => {
  append({ type: "confirmed", fingerprint: "a", fixId: "1", author: "Ankit" });
  append({ type: "confirmed", fingerprint: "a", fixId: "1", author: "louis" });
  assert.deepEqual(fs.readdirSync(process.env.ERRORBOOK_DIR).sort(), ["ankit.jsonl", "louis.jsonl"]);
  assert.equal(loadAll().length, 2);
});

test("a broken line is skipped, not fatal", () => {
  writeStarter();
  fs.appendFileSync(path.join(process.env.ERRORBOOK_DIR, "ankit.jsonl"), "{broken\n");
  assert.equal(loadAll().length, 3);
});

test("starter data: Ankit's fix wins with medium confidence, Louisa's is unproven", () => {
  writeStarter();
  const r = lookup("6ce249");
  assert.equal(r.kind, "exact");
  assert.deepEqual(r.fix, {
    fingerprint: "6ce249", fixId: "84282f50", fix: "Add a build script to package.json", author: "ankit",
    firstSeen: "2026-10-18T00:21:07Z", confirmations: 1, rejections: 0, returned: false, confidence: "medium",
  });
  assert.equal(r.alternatives[0].fixId, "21ecc490");
  assert.equal(r.alternatives[0].confidence, "unproven");
});

test("the spec's tree: rejected + returned makes Louisa's fix failed", () => {
  writeStarter();
  append({ type: "rejected", fingerprint: "6ce249", fixId: "21ecc490", author: "louis", ts: "2026-10-18T01:12:00Z" });
  append({ type: "returned", fingerprint: "6ce249", fixId: "21ecc490", author: "ankit", ts: "2026-10-18T03:40:00Z" });
  const bad = lookup("6ce249").alternatives[0];
  assert.equal(bad.rejections, 1);
  assert.equal(bad.returned, true);
  assert.equal(bad.confidence, "failed");
});

test("three downs from one person count once; from three people they count three times", () => {
  writeStarter();
  for (const ts of ["2026-10-19T01:00:00Z", "2026-10-19T02:00:00Z", "2026-10-19T03:00:00Z"]) {
    append({ type: "rejected", fingerprint: "6ce249", fixId: "21ecc490", author: "louis", ts });
  }
  assert.equal(lookup("6ce249").alternatives[0].rejections, 1);
});

test("loose: a similar error finds the team's fix; nothing similar gives none", () => {
  writeStarter();
  assert.equal(lookup("ffffff", { lang: "npm", errorType: "missing-script", file: null }).kind, "loose");
  assert.equal(lookup("ffffff", { lang: "node", errorType: "TypeError", file: "api.js" }).kind, "none");
  assert.equal(lookup("ffffff").kind, "none");
});

test("confidence table from the spec", () => {
  assert.equal(confidence(2, 0, false), "high");
  assert.equal(confidence(1, 0, false), "medium");
  assert.equal(confidence(0, 0, false), "unproven");
  assert.equal(confidence(0, 1, false), "low");
  assert.equal(confidence(3, 2, false), "failed");
  assert.equal(confidence(5, 0, true), "failed");
});

test("scrub removes secrets before they reach git", () => {
  const dirty = "connect postgres://admin:hunter2@db.local:5432 failed, PASSWORD=hunter2 token: sk-ant-abc123def456ghi789jkl";
  const clean = scrub(dirty);
  assert.ok(!clean.includes("hunter2"));
  assert.ok(!clean.includes("sk-ant-abc123"));
  const saved = append({ type: "solved", fingerprint: "x", loose: null, summary: "s", raw: dirty, fix: "Set DB_PASSWORD=hunter2 in .env", author: "ankit" });
  assert.ok(!JSON.stringify(saved).includes("hunter2"));
});