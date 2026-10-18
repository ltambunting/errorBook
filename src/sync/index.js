// errorbook sync: share your fixes and get your teammates', through git.
// Rules: only ever touch .errorbook/, stop on a conflict, say what happened.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { repoRoot, dataDir } from "../memory/paths.js";
import { loadAll } from "../memory/store.js";

const say = (msg) => console.log(`[errorbook] ${msg}`);

function git(...args) {
  return execFileSync("git", args, { cwd: repoRoot(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

// First line of git's error message, for a short explanation.
const why = (e) => String(e.stderr || e.message || e).trim().split("\n")[0];

// Which notebook files have actually changed, ignoring the .gitattributes we
// maintain ourselves. `git status --porcelain` prints two status letters, a
// space, then the path; a rename prints "old -> new", and we want the new name.
// --untracked-files=all is required: by default git collapses a new folder to
// ".errorbook/" and the .gitattributes inside it would never be recognised.
function notebookChanges(rel) {
  return git("status", "--porcelain", "--untracked-files=all", "--", rel)
    .split("\n")
    .filter(Boolean)
    .map((entry) => entry.slice(3).trim().split(" -> ").pop().replace(/^"|"$/g, ""))
    .filter((file) => path.basename(file) !== ".gitattributes");
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