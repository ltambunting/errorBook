// errorbook sync: share your fixes and get your teammates', through git.
// Rules: only ever touch .errorbook/, stop on a conflict, say what happened.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { repoRoot, dataDir } from "../memory/paths.js";
import { loadAll } from "../memory/store.js";

const say = (msg) => console.log(`[errorbook] ${msg}`);

function exec(args, { trim = true } = {}) {
  const out = execFileSync("git", args, { cwd: repoRoot(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return trim ? out.trim() : out;
}

function raw(...args) {
  return exec(args);
}

// `git config --get user.name` exits non-zero when the key is unset, and prints
// an empty line when it is set to "". Neither is a usable identity.
function configured(key) {
  try {
    return raw("config", "--get", key) !== "";
  } catch {
    return false;
  }
}

// The demo deliberately blanks the git identity, because "Author identity
// unknown" is one of the errors it shows. Sync still has to be able to write,
// so when git has no identity of its own it supplies one for the length of the
// command only -- nothing is written to any config file. ERRORBOOK_AUTHOR_NAME
// and ERRORBOOK_AUTHOR_EMAIL set it; without them sync still works rather than
// failing on the demo's own setup.
let identity = null;
function identityArgs() {
  if (identity) return identity;
  identity = [];
  if (!configured("user.name")) {
    identity.push("-c", `user.name=${process.env.ERRORBOOK_AUTHOR_NAME || process.env.ERRORBOOK_AUTHOR || "errorbook"}`);
  }
  if (!configured("user.email")) {
    identity.push("-c", `user.email=${process.env.ERRORBOOK_AUTHOR_EMAIL || "errorbook@localhost"}`);
  }
  return identity;
}

// Every git call goes through here, so a merge commit made by `git pull` gets
// the same identity the commit did.
function git(...args) {
  return exec([...identityArgs(), ...args]);
}

// Same, but byte-for-byte: no trimming, for output whose leading whitespace is
// part of the data.
function gitExact(...args) {
  return exec([...identityArgs(), ...args], { trim: false });
}

// First line of git's error message, for a short explanation.
const why = (e) => String(e.stderr || e.message || e).trim().split("\n")[0];

// Which notebook files have actually changed, ignoring the .gitattributes we
// maintain ourselves.
//
// Each -z entry is two status characters, a space, the path, then a NUL. The
// status characters can themselves be spaces -- " M" is modified but unstaged --
// so the output must never be trimmed before the three-character prefix is
// sliced off. Trimming it turned " M .errorbook/x.jsonl" into
// "M .errorbook/x.jsonl" and the slice then ate the leading dot of the path.
//
// -z also means paths are never quoted or escaped, so a name with a space or a
// non-ASCII character comes through as itself.
//
// --untracked-files=all is required: by default git collapses a new folder to
// ".errorbook/" and the .gitattributes inside it would never be recognised.
function notebookChanges(rel) {
  const fields = gitExact("status", "--porcelain", "-z", "--untracked-files=all", "--", rel).split("\0");
  const changed = [];
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (entry === "") continue;
    const status = entry.slice(0, 2);
    const file = entry.slice(3);
    // A rename or copy is followed by a second field holding the old path; the
    // new one is what changed.
    if (status[0] === "R" || status[0] === "C") i++;
    if (file !== "" && path.basename(file) !== ".gitattributes") changed.push(file);
  }
  return changed;
}

export function sync() {
  const dir = dataDir();
  const rel = path.relative(repoRoot(), dir) || ".errorbook";

  try {
    git("rev-parse", "--git-dir");
  } catch {
    say("This folder isn't a git repository, so there's nothing to sync with.");
    return { ok: false, step: "setup" };
  }

  fs.mkdirSync(dir, { recursive: true });

  const before = new Set(loadAll().map((line) => JSON.stringify(line)));

  // 1. Commit only .errorbook/, never anything else, and only when there is
  //    really something of yours to share. The .gitattributes below is
  //    bookkeeping we write ourselves, so it never counts as a note and never
  //    earns a commit of its own: it rides along with the first real one.
  let committed = 0;
  try {
    const changes = notebookChanges(rel);
    if (changes.length) {
      // If two people's versions of a notebook file meet, keep both sides' lines.
      const attrs = path.join(dir, ".gitattributes");
      if (!fs.existsSync(attrs)) fs.writeFileSync(attrs, "*.jsonl merge=union\n");
      git("add", "--", rel);
      committed = git("diff", "--cached", "--name-only", "--", rel).split("\n").filter(Boolean).length;
      if (committed) git("commit", "-m", "errorbook: sync team fixes", "--", rel);
      say(`Saved your new notes (${changes.join(", ")}).`);
    } else {
      say("No new notes of yours to share.");
    }
  } catch (e) {
    say(`Couldn't commit your notes: ${why(e)}`);
    return { ok: false, step: "commit" };
  }

  // 2. Get teammates' notes. A merge (not a rebase) never touches your other files.
  try {
    git("pull", "--no-rebase", "--no-edit");
  } catch (e) {
    let conflicted = [];
    try {
      conflicted = git("diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);
    } catch {}
    if (conflicted.length) {
      try {
        git("merge", "--abort");
      } catch {}
      say(`Stopped: pulling caused a conflict in ${conflicted.join(", ")}. Nothing was changed. Sort it out with your team, then sync again.`);
      return { ok: false, step: "pull", conflict: conflicted };
    }
    say(`Couldn't get teammates' notes: ${why(e)}`);
    return { ok: false, step: "pull" };
  }

  // 3. Share yours.
  try {
    git("push");
  } catch (e) {
    say(`Couldn't share your notes: ${why(e)}`);
    return { ok: false, step: "push" };
  }

  // 4. Report what arrived.
  const received = loadAll().filter((line) => !before.has(JSON.stringify(line)));
  if (received.length) {
    const names = [...new Set(received.map((line) => line.author))].join(", ");
    say(`Got ${received.length} new note${received.length === 1 ? "" : "s"} from ${names}.`);
  } else {
    say("Already up to date with the team.");
  }
  return { ok: true, committed, received };
}