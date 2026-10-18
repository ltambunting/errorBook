// Where errorbook keeps its files. Everything that touches disk resolves its
// paths here, so capture's retry counter, the notebook and the explanation
// cache always land in the same .errorbook, whichever subdirectory you run from.
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// The top folder of the git repo, so .errorbook is in the same place no matter
// which subfolder you run the command from. Cached per directory: one `git`
// call per cwd, but a chdir is still noticed.
const roots = new Map();
export function repoRoot() {
  const cwd = process.cwd();
  if (roots.has(cwd)) return roots.get(cwd);
  let root;
  try {
    root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    root = cwd; // not a git repo: use the current folder
  }
  roots.set(cwd, root);
  return root;
}

// The notebook folder, shared by the whole team. ERRORBOOK_DIR overrides it.
export function dataDir() {
  return path.resolve(process.env.ERRORBOOK_DIR || path.join(repoRoot(), '.errorbook'));
}

// Machine-only state that is never shared: retry counts, the explanation cache.
export function localDir() {
  return path.join(dataDir(), 'local');
}
