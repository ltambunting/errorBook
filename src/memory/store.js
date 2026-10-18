import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { dataDir } from "./paths.js";
import { scrub } from "../fingerprint/index.js";

// Names are always lowercase, so "Ankit" and "ankit" are the same person.
// "Ankit Sharma" → "ankit-sharma"
export function cleanName(name) {
  return String(name || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "someone";
}

// A slug, or null when there was nothing usable to slugify. cleanName falls
// back to "someone", which is a fine last resort but a bad way to decide that
// one source was empty and the next should be tried.
function slugOrNull(value) {
  const raw = String(value ?? "").trim();
  if (raw === "") return null;
  const slug = cleanName(raw);
  return slug === "someone" && !/^someone$/i.test(raw) ? null : slug;
}

function gitConfig(key) {
  try {
    return execFileSync("git", ["config", key], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return ""; // not a git repo, or the key is unset
  }
}

// Who is running the tool, in order of how deliberately it was stated:
// ERRORBOOK_AUTHOR_NAME, then the older ERRORBOOK_AUTHOR, then the git name,
// then the local part of an email, then a last resort.
//
// The demo blanks the local git user.name on purpose, and two-laptop mode leaves
// only the email set, so falling straight to "someone" from an empty git name
// would file both laptops' notes under the same anonymous author.
export function me() {
  return (
    slugOrNull(process.env.ERRORBOOK_AUTHOR_NAME) ??
    slugOrNull(process.env.ERRORBOOK_AUTHOR) ??
    slugOrNull(gitConfig("user.name")) ??
    slugOrNull(String(process.env.ERRORBOOK_AUTHOR_EMAIL || gitConfig("user.email")).split("@")[0]) ??
    "someone"
  );
}

// Same error + same fix text → same ID, no matter who saves it.
export function makeFixId(fingerprint, fixText) {
  const clean = String(fixText).toLowerCase().replace(/\s+/g, " ").replace(/[.!\s]+$/, "").trim();
  return crypto.createHash("sha1").update(`${fingerprint}|${clean}`).digest("hex").slice(0, 8);
}

// Add one line to the bottom of your own file. Never edits or deletes.
export function append(event) {
  const line = { v: 1, ...event };
  line.author = cleanName(line.author || me());
  line.ts ??= new Date().toISOString();
  if (line.type === "solved") {
    line.raw = scrub(line.raw);
    line.fix = scrub(line.fix);
    line.fixId ??= makeFixId(line.fingerprint, line.fix);
  }
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, `${line.author}.jsonl`), JSON.stringify(line) + "\n");
  return line;
}

// Read every person's file into one list.
export function loadAll() {
  const dir = dataDir();
  if (!fs.existsSync(dir)) return [];
  const events = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    const text = fs.readFileSync(path.join(dir, name), "utf8");
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/^\uFEFF/, "").trim(); // Windows editors sometimes add a hidden character
      if (!line) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue; // one broken line is skipped, never fatal
      }
      // JSON.parse succeeds on "null", "42" and "[]" too, and a null sailing
      // through here used to take out the whole notebook on the first e.type.
      // A junk line skips itself, nothing else.
      if (!event || typeof event !== "object" || Array.isArray(event)) continue;
      events.push(event);
    }
  }
  return events;
}

// --- measured lookups -------------------------------------------------------

// What a lookup can have come out as. "loose" is a similar error rather than
// the same one, so it is kept apart from an exact hit: the reader of a rate
// should be able to tell the two apart later even though both count as the
// notebook having had an answer.
export const LOOKUP_RESULTS = new Set(["hit", "loose", "miss"]);

// One line per question the notebook was asked, so the hit rate can be
// measured instead of inferred from what people happened to save.
//
// Deliberately nothing but the fingerprint, the outcome and who asked: no
// error text, no fix text, no command. A lookup line is written on every single
// failing run, including the ones nobody saves a fix for, so it is the one
// event type that must carry nothing worth scrubbing.
//
// Never throws. Asking the notebook a question must not be able to fail the
// command the developer actually ran, so an unwritable notebook, a full disk or
// a read-only checkout all end here as a quiet null.
export function appendLookup(fingerprint, result) {
  try {
    if (typeof fingerprint !== "string" || !fingerprint) return null;
    if (!LOOKUP_RESULTS.has(result)) return null;
    return append({ type: "lookup", fingerprint, result });
  } catch {
    return null;
  }
}
