// Auto-confirm's only piece of state: the fix a developer was just shown and
// did not say anything about. Machine-local and disposable -- it lives next to
// the retry counter in .errorbook/local (gitignored), never in the shared
// notebook, and holds no error text and no fix text, only the ids needed to
// find them again.
//
// Nothing here throws. A pending entry is a courtesy; a missing, corrupt or
// unwritable file must leave the command the developer actually ran exactly as
// it would have been.
import fs from "node:fs";
import path from "node:path";
import { localDir } from "./paths.js";

// Long enough to try a fix and run the command again, short enough that the
// next run is still the same piece of work.
export const PENDING_WINDOW_MS = 30 * 60 * 1000;

function pendingFile() {
  return path.join(localDir(), "pending.json");
}

function readStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(pendingFile(), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {}; // missing or corrupt: there is simply nothing pending
  }
}

function writeStore(store) {
  try {
    const file = pendingFile();
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    // Keep local state out of git even if the repo's .gitignore drifts.
    fs.writeFileSync(path.join(dir, ".gitignore"), "*\n");
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`);
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

// Remember that this command was run against this fix and nobody said whether
// it worked. Keyed by the command string: the next identical run is the
// evidence, so anything else running in between is irrelevant.
export function savePending({ command, fingerprint, fixId, author } = {}) {
  if (!command || !fingerprint || !fixId || !author) return null;
  const entry = { fingerprint, fixId, command, author, ts: new Date().toISOString() };
  const store = readStore();
  store[command] = entry;
  return writeStore(store) ? entry : null;
}

// The entry for one command, or null. A half-written entry counts as nothing:
// an auto-confirm is a vote in the notebook, so it is only cast on an entry
// that still has everything it needs.
export function readPending(command) {
  if (!command) return null;
  const entry = readStore()[command];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const { fingerprint, fixId, author, ts } = entry;
  if (!fingerprint || !fixId || !author || typeof fingerprint !== "string" || typeof fixId !== "string" || typeof author !== "string") return null;
  return { fingerprint, fixId, command, author, ts };
}

export function dropPending(command) {
  if (!command) return false;
  const store = readStore();
  if (!(command in store)) return false;
  delete store[command];
  return writeStore(store);
}

// Past the window, or undatable: the run happening now is new work rather than
// the same person retrying the fix they were just handed.
export function isPendingExpired(entry, now = Date.now()) {
  const at = Date.parse(entry?.ts ?? "");
  return !Number.isFinite(at) || now - at > PENDING_WINDOW_MS;
}
