import path from "node:path";
import { execFileSync } from "node:child_process";

// The top folder of the git repo, so .errorbook is in the same place
// no matter which subfolder you run the command from.
let root = null;
export function repoRoot() {
  if (root) return root;
  try {
    root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    root = process.cwd(); // not a git repo: use the current folder
  }
  return root;
}

// Where the notebook lives. ERRORBOOK_DIR overrides it (used by tests).
export function dataDir() {
  return process.env.ERRORBOOK_DIR || path.join(repoRoot(), ".errorbook");
}