import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { dataDir } from "./paths.js";
import { scrub } from "./scrub.js";

// Names are always lowercase, so "Ankit" and "ankit" are the same person.
// "Ankit Sharma" → "ankit-sharma"
export function cleanName(name) {
  return String(name || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "someone";
}

// Who is running the tool: their git name, lowercased.
export function me() {
  if (process.env.ERRORBOOK_AUTHOR) return cleanName(process.env.ERRORBOOK_AUTHOR);
  try {
    return cleanName(execFileSync("git", ["config", "user.name"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  } catch {
    return "someone";
  }
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
      try {
        events.push(JSON.parse(line));
      } catch {
        // one broken line is skipped, never fatal
      }
    }
  }
  return events;
}