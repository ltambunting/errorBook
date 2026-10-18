// Covers the dashboard: the arithmetic that lives inside dashboard/index.html,
// and the command that embeds the notebook into a copy of it.
//
// The page has to be one self-contained file that opens over file://, so its
// stats code cannot be imported. Instead it is lifted out of the page by its
// script id and evaluated here, which means these tests run against the exact
// code the browser runs -- there is no second copy to drift.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "../src/cli/cli.js";
import { createDisplay } from "../src/cli/display.js";
import { embed, buildHtml } from "../src/dashboard/index.js";
import { Writable } from "node:stream";

const PAGE = fileURLToPath(new URL("../dashboard/index.html", import.meta.url));
const html = fs.readFileSync(PAGE, "utf8");

function liftStats() {
  const block = html.match(/<script id="errorbook-stats">([\s\S]*?)<\/script>/);
  assert.ok(block, "dashboard/index.html has no errorbook-stats block to test");
  // eslint-disable-next-line no-new-func -- evaluating our own page's code on purpose
  return new Function(`${block[1]}; return ErrorbookStats;`)();
}
const S = liftStats();

const DAY = 86400_000;
const NOW = Date.parse("2026-10-18T09:00:00Z");
const daysAgo = (d, h = 0) => new Date(NOW - d * DAY + h * 3600_000).toISOString();

// A notebook shaped like the demo seed: two people, one error with two
// competing fixes, one fix that worked and then stopped working.
function seed() {
  return [
    { type: "solved", fingerprint: "6ce249", fixId: "b1", fix: "Add a build script", author: "ankit-aggarwal", ts: daysAgo(12), timeToSolve: 1380, summary: 'npm error missing script: "build"', loose: { lang: "npm", errorType: "missing-script", file: null } },
    { type: "solved", fingerprint: "6ce249", fixId: "b2", fix: "Reinstall node_modules", author: "louisa-tambunting", ts: daysAgo(11), timeToSolve: 2700 },
    { type: "confirmed", fingerprint: "6ce249", fixId: "b1", author: "louisa-tambunting", ts: daysAgo(9) },
    { type: "rejected", fingerprint: "6ce249", fixId: "b2", author: "ankit-aggarwal", ts: daysAgo(3) },
    { type: "solved", fingerprint: "204e89", fixId: "c1", fix: "Guard the list", author: "ankit-aggarwal", ts: daysAgo(13), timeToSolve: 3300, summary: "typeerror: cannot read properties of undefined", loose: { lang: "node", errorType: "TypeError", file: "cart.js" } },
    { type: "confirmed", fingerprint: "204e89", fixId: "c1", author: "louisa-tambunting", ts: daysAgo(6) },
    { type: "returned", fingerprint: "204e89", fixId: "c1", author: "louisa-tambunting", ts: daysAgo(2) },
    { type: "solved", fingerprint: "20116d", fixId: "e1", fix: "npm i -D eslint-config-airbnb", author: "ankit-aggarwal", ts: daysAgo(4), timeToSolve: 420 },
  ];
}
const find = (errors, id) => errors.find((e) => e.fingerprint === id);

// --- hit rate --------------------------------------------------------------

test("the hit rate counts the first solve as a miss and every later encounter as a hit", () => {
  const rate = S.hitRate(seed());
  // 3 distinct errors were each met cold once; the other 5 events found an
  // answer already in the notebook.
  assert.equal(rate.misses, 3);
  assert.equal(rate.hits, 5);
  assert.equal(rate.total, 8);
  assert.equal(rate.percent, 63);
});

test("an empty notebook has no hit rate, which is not the same as zero", () => {
  const rate = S.hitRate([]);
  assert.equal(rate.percent, null, "0% would claim the team never finds anything");
  assert.equal(rate.total, 0);
});

test("the second person to hit the same error is a hit, even with no votes", () => {
  const rate = S.hitRate([
    { type: "solved", fingerprint: "aaa", fixId: "1", author: "ankit", ts: daysAgo(3) },
    { type: "solved", fingerprint: "aaa", fixId: "2", author: "louisa", ts: daysAgo(2) },
  ]);
  assert.equal(rate.misses, 1);
  assert.equal(rate.hits, 1);
  assert.equal(rate.percent, 50);
});

test("junk lines are ignored rather than counted", () => {
  const rate = S.hitRate([null, 42, [], "text", { nope: true }, ...seed()]);
  assert.equal(rate.total, 8, "only real events count");
});

// --- per-error rollup ------------------------------------------------------

test("an error is ranked by how often it bites times how many people", () => {
  const errors = S.byError(seed());
  const build = find(errors, "6ce249");
  assert.equal(build.occurrences, 4);
  assert.equal(build.peopleAffected, 2);
  assert.equal(build.score, 8);
  // 1380 + 2700 seconds
  assert.equal(build.hoursLost, 1.1);
  assert.deepEqual(build.people.sort(), ["ankit-aggarwal", "louisa-tambunting"]);

  const cart = find(errors, "204e89");
  assert.equal(cart.score, 6);
  const eslint = find(errors, "20116d");
  assert.equal(eslint.score, 1, "one person, once");

  assert.deepEqual(errors.map((e) => e.fingerprint), ["6ce249", "204e89", "20116d"], "highest score first");
});

test("an error that hits five people once outranks one that hits one person five times", () => {
  const many = [];
  for (let i = 0; i < 5; i++) {
    many.push({ type: "solved", fingerprint: "wide", fixId: `w${i}`, author: `p${i}`, ts: daysAgo(10 - i) });
    many.push({ type: "solved", fingerprint: "deep", fixId: `d${i}`, author: "solo", ts: daysAgo(10 - i) });
  }
  const errors = S.byError(many);
  assert.equal(find(errors, "wide").score, 25);
  assert.equal(find(errors, "deep").score, 5);
  assert.equal(errors[0].fingerprint, "wide");
});

test("competing fixes are ranked, and the rejected one is kept but last", () => {
  const build = find(S.byError(seed()), "6ce249");
  assert.equal(build.fixes.length, 2);
  assert.equal(build.fixes[0].fixId, "b1");
  assert.equal(build.fixes[0].confidence, "medium");
  assert.deepEqual(build.fixes[0].confirmedBy, ["louisa-tambunting"]);
  assert.equal(build.fixes[1].fixId, "b2", "a dead end is still worth showing");
  assert.equal(build.fixes[1].confidence, "low");
  assert.deepEqual(build.fixes[1].rejectedBy, ["ankit-aggarwal"]);
});

test("a fix that worked and then came back is reported as failed", () => {
  const cart = find(S.byError(seed()), "204e89");
  assert.equal(cart.returned, true);
  assert.equal(cart.fixes[0].returned, true);
  assert.equal(cart.fixes[0].confidence, "failed");
  assert.deepEqual(cart.fixes[0].confirmedBy, ["louisa-tambunting"], "who confirmed it is still recorded");
});

test("per-error detail says who solved it and how long it took", () => {
  const eslint = find(S.byError(seed()), "20116d");
  assert.equal(eslint.fixes[0].author, "ankit-aggarwal");
  assert.equal(eslint.fixes[0].timeToSolve, 420);
  assert.equal(eslint.fixes[0].confidence, "unproven", "nobody has checked it");
  assert.deepEqual(eslint.fixes[0].confirmedBy, []);
});

test("nobody confirms their own fix, and one person votes once", () => {
  const errors = S.byError([
    { type: "solved", fingerprint: "aaa", fixId: "1", fix: "x", author: "ankit", ts: daysAgo(5) },
    { type: "confirmed", fingerprint: "aaa", fixId: "1", author: "ankit", ts: daysAgo(4) },
    { type: "confirmed", fingerprint: "aaa", fixId: "1", author: "louisa", ts: daysAgo(3) },
    { type: "confirmed", fingerprint: "aaa", fixId: "1", author: "louisa", ts: daysAgo(2) },
  ]);
  assert.deepEqual(errors[0].fixes[0].confirmedBy, ["louisa"]);
  assert.equal(errors[0].fixes[0].confidence, "medium");
});

test("a rejection replaces that person's earlier confirmation", () => {
  const errors = S.byError([
    { type: "solved", fingerprint: "aaa", fixId: "1", fix: "x", author: "ankit", ts: daysAgo(5) },
    { type: "confirmed", fingerprint: "aaa", fixId: "1", author: "louisa", ts: daysAgo(4) },
    { type: "rejected", fingerprint: "aaa", fixId: "1", author: "louisa", ts: daysAgo(3) },
  ]);
  assert.deepEqual(errors[0].fixes[0].confirmedBy, []);
  assert.deepEqual(errors[0].fixes[0].rejectedBy, ["louisa"]);
});

test("a vote for a fix the notebook has not got is ignored, not fatal", () => {
  const errors = S.byError([
    { type: "confirmed", fingerprint: "aaa", fixId: "missing", author: "louisa", ts: daysAgo(3) },
  ]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].fixes.length, 0);
  assert.equal(errors[0].occurrences, 1, "it still happened to someone");
});

// --- timeline --------------------------------------------------------------

test("the timeline is fourteen days, oldest first, split into hits and misses", () => {
  const days = S.timeline(seed(), NOW, 14);
  assert.equal(days.length, 14);
  const dates = days.map((d) => d.date);
  assert.deepEqual([...dates].sort(), dates, "oldest first");

  const total = days.reduce((n, d) => n + d.total, 0);
  const hits = days.reduce((n, d) => n + d.hits, 0);
  assert.equal(total, 8, "every seeded event falls inside the window");
  assert.equal(hits, 5, "and the hit/miss split matches the headline number");
});

test("anything older than the window is left out, not folded into day one", () => {
  const days = S.timeline([
    { type: "solved", fingerprint: "old", fixId: "1", author: "ankit", ts: daysAgo(400) },
    { type: "solved", fingerprint: "new", fixId: "2", author: "ankit", ts: daysAgo(1) },
  ], NOW, 14);
  assert.equal(days.reduce((n, d) => n + d.total, 0), 1);
  assert.equal(days[0].total, 0, "the ancient event is not piled onto the first day");
});

test("an empty notebook still produces a full, flat fortnight", () => {
  const days = S.timeline([], NOW, 14);
  assert.equal(days.length, 14);
  assert.equal(days.reduce((n, d) => n + d.total, 0), 0);
});

// --- summarise -------------------------------------------------------------

test("summarise ties the whole page together", () => {
  const stats = S.summarise(seed(), NOW, 14);
  assert.equal(stats.hitRate.percent, 63);
  assert.equal(stats.errors.length, 3);
  assert.equal(stats.timeline.length, 14);
  assert.deepEqual(stats.people, ["ankit-aggarwal", "louisa-tambunting"]);
  // 1.1 + 0.9 + 0.1
  assert.equal(stats.totalHoursLost, 2.1);
});

test("summarise survives nonsense input", () => {
  for (const input of [[], null, undefined, [null, 1, "x"]]) {
    const stats = S.summarise(input, NOW, 14);
    assert.equal(stats.errors.length, 0);
    assert.equal(stats.timeline.length, 14);
    assert.deepEqual(stats.people, []);
  }
});

test("an author slug is shown as a first name, as in the terminal", () => {
  assert.equal(S.firstName("ankit-aggarwal"), "ankit");
  assert.equal(S.firstName(""), "someone");
  assert.equal(S.firstName(null), "someone");
});

// --- measured vs derived ---------------------------------------------------
// Two ways to get one number, and the page must never blend them. A notebook
// written before `run` recorded lookups has none, and keeps the inferred rate
// it has always shown; a notebook with lookups in it reports what was counted.

// The seed, plus lookups: 3 hits, 1 loose and 1 miss, so 4 of 5 is 80%.
function withLookups() {
  return seed().concat([
    { type: "lookup", fingerprint: "6ce249", result: "hit", author: "louisa-tambunting", ts: daysAgo(5) },
    { type: "lookup", fingerprint: "6ce249", result: "hit", author: "ankit-aggarwal", ts: daysAgo(4) },
    { type: "lookup", fingerprint: "204e89", result: "hit", author: "louisa-tambunting", ts: daysAgo(3) },
    { type: "lookup", fingerprint: "e73c44", result: "loose", author: "ankit-aggarwal", ts: daysAgo(2) },
    { type: "lookup", fingerprint: "28b25a", result: "miss", author: "ankit-aggarwal", ts: daysAgo(1) },
  ]);
}

test("lookupRate counts a loose match as an answer and a miss as not", () => {
  const rate = S.lookupRate(withLookups());
  assert.equal(rate.hits, 4, "3 exact and 1 similar: the notebook had something either way");
  assert.equal(rate.misses, 1);
  assert.equal(rate.total, 5);
  assert.equal(rate.percent, 80);
  assert.equal(rate.measured, true);
});

test("lookupRate ignores everything that is not a lookup, and junk results", () => {
  assert.equal(S.lookupRate(seed()).total, 0, "a notebook with no lookups has nothing to measure");
  assert.equal(S.lookupRate(seed()).percent, null, "which is not 0%");
  assert.equal(S.lookupRate([
    { type: "lookup", fingerprint: "a", result: "nonsense", ts: daysAgo(1) },
    { type: "lookup", fingerprint: "a", ts: daysAgo(1) },
  ]).total, 0, "a result nobody writes is not counted either way");
});

test("a notebook with no lookups keeps the derived rate it always had", () => {
  const stats = S.summarise(seed(), NOW, 14);
  assert.equal(stats.hitRate.measured, false);
  assert.equal(stats.hitRate.percent, 63, "unchanged: 5 of 8 encounters");
});

test("a notebook with lookups reports the measured rate instead", () => {
  const stats = S.summarise(withLookups(), NOW, 14);
  assert.equal(stats.hitRate.measured, true);
  assert.equal(stats.hitRate.percent, 80);
  assert.notEqual(stats.hitRate.percent, 63, "the derived number is not reported once there is a real one");
  assert.equal(stats.hitRate.total, 5, "lookups only: the two methods are never added together");
});

test("lookups move no other number on the page", () => {
  const plain = S.summarise(seed(), NOW, 14);
  const measured = S.summarise(withLookups(), NOW, 14);

  assert.deepEqual(measured.people, plain.people, "a lookup is not a person affected");
  assert.equal(measured.totalHoursLost, plain.totalHoursLost);
  assert.equal(measured.errors.length, plain.errors.length, "a looked-up error is not an error the team hit");
  assert.deepEqual(
    measured.errors.map((e) => [e.fingerprint, e.occurrences, e.peopleAffected, e.score, e.fixes.map((f) => f.confidence).join(",")]),
    plain.errors.map((e) => [e.fingerprint, e.occurrences, e.peopleAffected, e.score, e.fixes.map((f) => f.confidence).join(",")]),
  );
  assert.deepEqual(measured.timeline.map((d) => d.total), plain.timeline.map((d) => d.total));
});

test("a notebook of nothing but lookups is a rate and no errors", () => {
  const stats = S.summarise(withLookups().filter((e) => e.type === "lookup"), NOW, 14);
  assert.equal(stats.hitRate.percent, 80);
  assert.deepEqual(stats.errors, []);
  assert.deepEqual(stats.people, []);
  assert.equal(stats.totalHoursLost, 0);
});

// --- the page itself -------------------------------------------------------

test("the page is one self-contained file", () => {
  assert.doesNotMatch(html, /<script[^>]+src=/i, "no external scripts");
  assert.doesNotMatch(html, /<link[^>]+href=/i, "no external stylesheets");
  assert.match(html, /<script type="application\/json" id="errorbook-data">/, "has a data block to fill");
  assert.match(html, /askForFiles/, "and a picker, so it still works with no data embedded");
  assert.match(html, /type: 'file'/, "which is a real file input");
});

test("embedding cannot break out of the script block", () => {
  const nasty = { events: [{ fix: "</script><script>alert(1)</script>", author: "x" }] };
  const out = embed(nasty);
  assert.doesNotMatch(out, /<\/script>/i, "a closing tag would end the block early");
  assert.deepEqual(JSON.parse(out), nasty, "and it still parses back to the same data");

  const page = buildHtml(html, nasty);
  const block = page.match(/<script type="application\/json" id="errorbook-data">([\s\S]*?)<\/script>/);
  assert.deepEqual(JSON.parse(block[1]), nasty);
});

test("buildHtml replaces only the data block", () => {
  const page = buildHtml(html, { events: seed() });
  assert.equal(page.length > html.length, true);
  // Everything either side of the data block is untouched.
  assert.ok(page.includes("<title>errorbook - team memory</title>"));
  assert.ok(page.includes("var ErrorbookStats = (function () {"));
  assert.equal((page.match(/id="errorbook-data"/g) || []).length, 1);
});

test("buildHtml refuses a template it does not recognise", () => {
  assert.throws(() => buildHtml("<html>nothing here</html>", { events: [] }), /no errorbook-data block/);
});

// --- the command -----------------------------------------------------------

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "eb-dash-"));
  process.env.ERRORBOOK_DIR = dir;
  process.env.ERRORBOOK_AUTHOR = "ankit";
});

function sink() {
  const out = [], err = [];
  const stream = (bucket) => new Writable({ write(c, e, cb) { bucket.push(c.toString()); cb(); } });
  return { out: stream(out), err: stream(err), stdout: () => out.join(""), stderr: () => err.join("") };
}

test("errorbook dashboard writes a page with the notebook inside it, and opens it", async () => {
  fs.writeFileSync(path.join(dir, "ankit.jsonl"), seed().map((e) => JSON.stringify({ v: 1, ...e })).join("\n") + "\n");

  const ui = sink();
  let opened = null;
  const code = await runCli(["dashboard"], {
    ui: createDisplay(ui.out, ui.err),
    prompts: { interactive: false, async ask() { return ""; }, async yes() { return false; }, close() {} },
    openInBrowser: (file) => { opened = file; return true; },
  });

  assert.equal(code, 0);
  assert.match(ui.stdout(), /Wrote .*dashboard\.html/);
  assert.match(ui.stdout(), /8 notebook entries/);
  assert.ok(opened, "the page is opened for you");

  const page = fs.readFileSync(opened, "utf8");
  const block = page.match(/<script type="application\/json" id="errorbook-data">([\s\S]*?)<\/script>/);
  const payload = JSON.parse(block[1]);
  assert.equal(payload.events.length, 8);
  assert.equal(payload.notebook, dir);
  assert.ok(Date.parse(payload.generatedAt) > 0);

  // The generated page is a sibling of the retry counter, and gitignored.
  assert.equal(path.basename(path.dirname(opened)), "local");
  assert.equal(fs.readFileSync(path.join(path.dirname(opened), ".gitignore"), "utf8").trim(), "*");
});

test("--no-open writes the page without launching a browser", async () => {
  const ui = sink();
  let opened = false;
  const code = await runCli(["dashboard", "--no-open"], {
    ui: createDisplay(ui.out, ui.err),
    prompts: { interactive: false, async ask() { return ""; }, async yes() { return false; }, close() {} },
    openInBrowser: () => { opened = true; return true; },
  });
  assert.equal(code, 0);
  assert.equal(opened, false);
  assert.match(ui.stdout(), /Wrote /);
});

test("an empty notebook still produces a page, and says so", async () => {
  const ui = sink();
  const code = await runCli(["dashboard", "--no-open"], {
    ui: createDisplay(ui.out, ui.err),
    prompts: { interactive: false, async ask() { return ""; }, async yes() { return false; }, close() {} },
    openInBrowser: () => true,
  });
  assert.equal(code, 0);
  assert.match(ui.stdout(), /0 notebook entries/);
  assert.match(ui.stdout(), /notebook is empty/);
});

test("a notebook with a bare null line does not stop the dashboard", async () => {
  fs.writeFileSync(path.join(dir, "ankit.jsonl"),
    "null\n{broken\n" + JSON.stringify({ v: 1, ...seed()[0] }) + "\n");
  const ui = sink();
  let opened = null;
  const code = await runCli(["dashboard"], {
    ui: createDisplay(ui.out, ui.err),
    prompts: { interactive: false, async ask() { return ""; }, async yes() { return false; }, close() {} },
    openInBrowser: (f) => { opened = f; return true; },
  });
  assert.equal(code, 0);
  assert.match(ui.stdout(), /1 notebook entry/);
  const page = fs.readFileSync(opened, "utf8");
  const payload = JSON.parse(page.match(/id="errorbook-data">([\s\S]*?)<\/script>/)[1]);
  assert.equal(payload.events.length, 1);
});

test("the usage text mentions the dashboard", async () => {
  const ui = sink();
  await runCli([], {
    ui: createDisplay(ui.out, ui.err),
    prompts: { interactive: false, async ask() { return ""; }, async yes() { return false; }, close() {} },
  });
  assert.match(ui.stderr(), /errorbook dashboard/);
});

// --- the renderer ----------------------------------------------------------
// The page has to open over file://, which rules out a bundler and also rules
// out the browser-automation tooling available here. So the renderer is lifted
// out by id and run against the smallest DOM that satisfies it: enough to catch
// a field that summarise() does not actually return, which is the failure that
// would otherwise only show up in the demo.

function fakeDom() {
  const nodes = {};
  class El {
    constructor(tag) { this.tagName = tag; this.children = []; this.attrs = {}; this._text = ""; }
    appendChild(kid) { this.children.push(kid); return kid; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    addEventListener() {}
    set className(v) { this.attrs.class = v; }
    get className() { return this.attrs.class || ""; }
    set textContent(v) { this._text = String(v); this.children = []; }
    get textContent() {
      return this._text + this.children.map((k) => k.textContent).join("");
    }
  }
  const make = (tag) => new El(tag);
  for (const id of ["app", "meta", "foot"]) nodes[id] = make("div");
  return {
    nodes,
    document: {
      createElement: make,
      createTextNode: (s) => { const n = make("#text"); n.textContent = s; return n; },
      getElementById: (id) => nodes[id],
    },
    text: () => ["meta", "app", "foot"].map((id) => nodes[id].textContent).join("\n"),
  };
}

function renderWith(events, notebook = "/tmp/demo/.errorbook") {
  const stats = html.match(/<script id="errorbook-stats">([\s\S]*?)<\/script>/)[1];
  const renderer = html.match(/<script id="errorbook-render">([\s\S]*?)<\/script>/)[1];
  assert.ok(renderer, "dashboard/index.html has no errorbook-render block");

  const dom = fakeDom();
  dom.nodes["errorbook-data"] = { textContent: JSON.stringify({ events, notebook, generatedAt: new Date().toISOString() }) };
  // eslint-disable-next-line no-new-func -- running our own page's code on purpose
  new Function("document", "window", `${stats}; ${renderer}`)(dom.document, {});
  return dom.text();
}

test("the page renders the headline number, the errors and the fortnight", () => {
  const out = renderWith(seed());

  // The one big number, and the sentence that explains what it means.
  assert.match(out, /63%/);
  assert.match(out, /answered from the team notebook/);
  assert.match(out, /5 of 8 encounters had an answer waiting/);

  // Top errors, with the ranking columns.
  assert.match(out, /top errors, by how often times how many/);
  assert.match(out, /6ce249/);
  assert.match(out, /missing-script/);

  // Per-error detail: who solved it, who confirmed, whether it came back.
  assert.match(out, /every error, in detail/);
  assert.match(out, /solved by ankit/);
  assert.match(out, /confirmed by louisa/);
  assert.match(out, /rejected by ankit/);
  assert.match(out, /the error came back/);
  assert.match(out, /took 23 min/, "1380 seconds reads as minutes");

  // The timeline, and the header summary.
  assert.match(out, /the last two weeks/);
  assert.match(out, /nobody had it yet/);
  assert.match(out, /ankit, louisa - 3 errors - 2\.1 hours lost/);

  // Slugs are never shown raw, here either.
  assert.doesNotMatch(out, /ankit-aggarwal/);
});

test("the page labels a derived rate as derived", () => {
  const out = renderWith(seed());
  assert.match(out, /Derived, not measured/);
  assert.doesNotMatch(out, /Measured from lookups/);
  assert.match(out, /5 of 8 encounters had an answer waiting/);
});

test("the page labels a measured rate as measured, once, and in place of the other", () => {
  const out = renderWith(withLookups());
  assert.match(out, /80%/);
  assert.match(out, /4 of 5 lookups had an answer waiting/);
  assert.equal(out.match(/Measured from lookups/g).length, 1, "stated once, next to the number");
  assert.doesNotMatch(out, /Derived, not measured/, "never both labels on one page");
  assert.doesNotMatch(out, /63%/, "and never the other method's number");
});

test("the page renders a notebook of nothing but lookups", () => {
  const out = renderWith(withLookups().filter((e) => e.type === "lookup"));
  assert.match(out, /80%/);
  assert.match(out, /Measured from lookups/);
  assert.match(out, /the last two weeks/, "the rest of the page still renders");
  assert.doesNotMatch(out, /top errors/, "with nothing to rank");
});

test("the page renders an empty notebook without the file picker claiming data", () => {
  const out = renderWith([]);
  assert.match(out, /No notebook is embedded in this file/);
  assert.match(out, /errorbook dashboard/);
  assert.doesNotMatch(out, /answered from the team notebook/, "no headline number with nothing to show");
});

test("the page survives a notebook of nothing but junk", () => {
  const out = renderWith([null, 7, [], "x", { no: "fingerprint" }]);
  assert.match(out, /No notebook is embedded|answered from the team notebook/);
});
