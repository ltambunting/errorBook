import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { append, loadAll, lookup, me, scrub } from "../src/memory/index.js";
import { cleanName } from "../src/memory/store.js";
import { confidence } from "../src/memory/tally.js";
import { fingerprint } from "../src/fingerprint/index.js";

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

// The seam between the two modules: what fingerprint() reports for a real npm
// failure has to loose-match what the notebook stored, or a fix saved against
// one script name is invisible from another.
test("a live `npm run doesnotexist` loose-matches the notebook's 6ce249 entry", () => {
  writeStarter();
  const captured = fs.readFileSync(
    new URL("../samples/npm-missing-script-doesnotexist-ankit.txt", import.meta.url),
    "utf8",
  );
  const { id, loose } = fingerprint(captured);

  // A different script, so the exact id cannot be the one the notebook knows.
  assert.equal(id, "e73c44");
  assert.notEqual(id, "6ce249");
  assert.deepEqual(loose, { lang: "npm", errorType: "missing-script", file: null });

  const found = lookup(id, loose);
  assert.equal(found.kind, "loose");
  assert.equal(found.fix.fingerprint, "6ce249");
  assert.equal(found.fix.fix, "Add a build script to package.json");
  assert.equal(found.fix.author, "ankit");

  // Without the loose description there is nothing to go on.
  assert.equal(lookup(id).kind, "none");
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
// Author resolution. The demo blanks the local git user.name on purpose and
// two-laptop mode leaves only the email set, so every rung of this ladder gets
// used in practice.
test("me() prefers the name you stated, then git, then an email, then gives up", () => {
  const vars = ["ERRORBOOK_AUTHOR_NAME", "ERRORBOOK_AUTHOR", "ERRORBOOK_AUTHOR_EMAIL"];
  const saved = Object.fromEntries(vars.map((v) => [v, process.env[v]]));
  const set = (values) => {
    for (const v of vars) {
      if (values[v] === undefined) delete process.env[v];
      else process.env[v] = values[v];
    }
  };
  try {
    // 1. ERRORBOOK_AUTHOR_NAME wins, slugified, and never falls through to
    //    "someone" just because the machine has no git identity.
    set({ ERRORBOOK_AUTHOR_NAME: "Ankit Aggarwal" });
    assert.equal(me(), "ankit-aggarwal");

    set({ ERRORBOOK_AUTHOR_NAME: "Ankit Aggarwal", ERRORBOOK_AUTHOR: "someone-else", ERRORBOOK_AUTHOR_EMAIL: "x@y.com" });
    assert.equal(me(), "ankit-aggarwal", "the stated name outranks the others");

    // Punctuation and spacing are normalised the same way stored authors are.
    for (const [given, want] of [
      ["  Louisa   Tambunting  ", "louisa-tambunting"],
      ["O'Brien", "o-brien"],
      ["ANKIT", "ankit"],
      ["ankit.aggarwal", "ankit-aggarwal"],
    ]) {
      set({ ERRORBOOK_AUTHOR_NAME: given });
      assert.equal(me(), want, `${JSON.stringify(given)} should slugify to ${want}`);
    }

    // 2. The older variable still works, one rung down.
    set({ ERRORBOOK_AUTHOR: "Louisa Tambunting" });
    assert.equal(me(), "louisa-tambunting");

    // 3. The git name comes next, and outranks any email.
    set({ ERRORBOOK_AUTHOR_EMAIL: "someone.else@example.com" });
    assert.equal(me(), cleanName(execFileSync("git", ["config", "user.name"], { encoding: "utf8" })),
      "a configured git name beats an email address");

    // Whatever it resolves to is always a usable filename stem.
    set({ ERRORBOOK_AUTHOR_NAME: "Ankit Aggarwal" });
    assert.match(me(), /^[a-z0-9][a-z0-9-]*$/);
  } finally {
    set(saved);
  }
});

test("the resolved author is what append files the note under", () => {
  const saved = process.env.ERRORBOOK_AUTHOR_NAME;
  const savedAuthor = process.env.ERRORBOOK_AUTHOR;
  try {
    delete process.env.ERRORBOOK_AUTHOR;
    process.env.ERRORBOOK_AUTHOR_NAME = "Ankit Aggarwal";
    const line = append({ type: "confirmed", fingerprint: "6ce249", fixId: "1" });
    assert.equal(line.author, "ankit-aggarwal");
    assert.deepEqual(fs.readdirSync(process.env.ERRORBOOK_DIR), ["ankit-aggarwal.jsonl"]);
  } finally {
    if (saved === undefined) delete process.env.ERRORBOOK_AUTHOR_NAME; else process.env.ERRORBOOK_AUTHOR_NAME = saved;
    if (savedAuthor === undefined) delete process.env.ERRORBOOK_AUTHOR; else process.env.ERRORBOOK_AUTHOR = savedAuthor;
  }
});

// The email and last-resort rungs are only reachable when git has no name at
// all. This machine has a global one, so they are checked in a child process
// with git's own config files taken out of the picture.
test("with no git name at all, me() uses the email local part, then gives up", () => {
  const probe = `
    import { me } from ${JSON.stringify(new URL("../src/memory/index.js", import.meta.url).href)};
    process.stdout.write(me());
  `;
  const run = (env) =>
    execFileSync(process.execPath, ["--input-type=module", "-e", probe], {
      encoding: "utf8",
      cwd: os.tmpdir(), // not a git repo
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        // Neither git's global nor system config can supply a name here.
        GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
        GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
        ...env,
      },
    });

  // Sanity: with nothing at all, the last resort is the last resort.
  assert.equal(run({}), "someone");

  // An email is enough to tell two people apart, so it beats "someone".
  assert.equal(run({ ERRORBOOK_AUTHOR_EMAIL: "ankit.acoolguy@gmail.com" }), "ankit-acoolguy");
  assert.equal(run({ ERRORBOOK_AUTHOR_EMAIL: "louisa@example.com" }), "louisa");

  // And the stated name still wins over everything, with no git in sight.
  assert.equal(run({ ERRORBOOK_AUTHOR_NAME: "Ankit Aggarwal", ERRORBOOK_AUTHOR_EMAIL: "x@y.com" }), "ankit-aggarwal");

  // A name that slugifies to nothing is treated as unset: the next source gets
  // its turn rather than the author silently becoming "someone".
  assert.equal(run({ ERRORBOOK_AUTHOR_NAME: "!!!", ERRORBOOK_AUTHOR_EMAIL: "louisa@example.com" }), "louisa");

  // ERRORBOOK_AUTHOR_NAME set to anything usable must never yield "someone".
  for (const name of ["Ankit", "ankit aggarwal", "O'Brien", "Zoë", "a"]) {
    const got = run({ ERRORBOOK_AUTHOR_NAME: name });
    assert.notEqual(got, "someone", `${JSON.stringify(name)} resolved to "someone"`);
  }
});
