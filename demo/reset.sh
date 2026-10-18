#!/usr/bin/env sh
# Builds demo/project/ in all four broken states, so the walkthrough in
# README.md can be run again from scratch. Safe to run any number of times.
#
# demo/template/ is the source of truth; demo/project/ is generated and
# gitignored, including its own .git. The demo needs a repository of its own for
# two reasons: errorbook then resolves .errorbook to the demo rather than to this
# repo, and blanking the git identity there cannot disturb your real settings.
set -eu

DEMO="$(cd "$(dirname "$0")" && pwd)"
PROJECT="$DEMO/project"

say() { printf '%s\n' "$*"; }

# --- 3. port 3000: let go of it, so the next demo can take it again ---------
# Best effort on both Windows and POSIX; never fatal if nothing is listening.
if command -v netstat >/dev/null 2>&1 && command -v taskkill >/dev/null 2>&1; then
  for pid in $(netstat -ano 2>/dev/null | grep 'LISTENING' | grep ':3000[^0-9]' | awk '{print $NF}' | sort -u); do
    taskkill //F //PID "$pid" >/dev/null 2>&1 || true
  done
elif command -v lsof >/dev/null 2>&1; then
  for pid in $(lsof -ti tcp:3000 2>/dev/null || true); do
    kill "$pid" 2>/dev/null || true
  done
fi

# Windows will not remove a directory that any shell is sitting in, and the
# natural place to be when re-running this is inside the project itself. Say so
# plainly rather than half-deleting it.
case "$PWD/" in
  "$PROJECT"/*)
    say "You are inside demo/project, which this script has to delete."
    say "Run 'cd \"$DEMO\"' first, then try again."
    exit 1
    ;;
esac

# Windows will not always let the directory itself be removed -- another shell
# sitting in it, or a file sync client holding a handle -- but its contents can
# still go. Emptying it is as good as recreating it, and beats leaving the
# project half-deleted because `rm -rf` stopped partway.
if ! rm -rf "$PROJECT" 2>/dev/null; then
  find "$PROJECT" -mindepth 1 -delete 2>/dev/null || true
  if [ -n "$(ls -A "$PROJECT" 2>/dev/null)" ]; then
    say "Could not clear $PROJECT. Close anything open in it and try again."
    exit 1
  fi
fi

# --- optional: a shared remote, for the two-laptop demo --------------------
# DEMO_REMOTE=<url> clones that repository instead of starting a fresh one, and
# keeps its origin, so `errorbook sync` really pushes and pulls between two
# machines. Unset, everything below behaves exactly as it always has.
if [ -n "${DEMO_REMOTE:-}" ]; then
  say "Cloning $DEMO_REMOTE into demo/project ..."
  git clone -q "$DEMO_REMOTE" "$PROJECT"
  say "origin: $(git -C "$PROJECT" remote get-url origin)"
fi

mkdir -p "$PROJECT"
cd "$PROJECT"

# --- 1. missing build script, and 2. a module that is never installed ------
# With a remote, whatever the other laptop already pushed wins; only what is
# missing is filled in, so a populated remote is never overwritten.
for file in package.json app.mjs server.js; do
  if [ ! -e "$file" ]; then
    cp "$DEMO/template/$file" "$file"
  fi
done
if [ ! -e .gitignore ]; then
  cat > .gitignore <<'IGNORE'
node_modules/
.errorbook/local/
IGNORE
fi
rm -rf node_modules package-lock.json

# --- the team's notebook ---------------------------------------------------
# A clone may already carry the team's real notebook. Seeding would delete it,
# which is the opposite of what the two-laptop demo is for, so it only seeds
# when there is nothing there.
if [ -n "$(find .errorbook -name '*.jsonl' 2>/dev/null)" ]; then
  say "Notebook: kept $(find .errorbook -name '*.jsonl' | wc -l | tr -d ' ') file(s) that came from the remote."
else
  node "$DEMO/template/seed.mjs" "$PROJECT/.errorbook"
fi

# --- 4. git identity unset -------------------------------------------------
# The identity is set to the empty string rather than unset. Unsetting it is not
# enough: git falls back to your global user.name and the commit simply
# succeeds on any configured machine. (user.useConfigOnly only stops git
# guessing from the hostname; it does not stop the global config.) An empty
# local value overrides the global one and produces the real
# "Author identity unknown", without touching your own settings.
#
# With a remote, only user.name is blanked. The email is left as your global one
# so the clone keeps a usable half-identity: `git commit` still fails on the
# missing name, which is the error being demonstrated, while `errorbook sync`
# can supply a name of its own and push to the shared repo.
if [ ! -d .git ]; then
  git init -q .
fi
git config user.useConfigOnly true
git config user.name ""
if [ -z "${DEMO_REMOTE:-}" ]; then
  git config user.email ""
fi

# One seed commit, made with an explicit identity so that creating it does not
# hit the very error we are about to demonstrate. A clone already has history.
git add -A
if ! git rev-parse HEAD >/dev/null 2>&1; then
  git -c user.name=seed -c user.email=seed@example.com commit -q -m "errorbook demo project"
elif ! git diff --cached --quiet; then
  git -c user.name=seed -c user.email=seed@example.com commit -q -m "errorbook demo project files"
fi

# --- an empty remote needs its first push ----------------------------------
# Cloning an empty repository leaves a branch with no commits and no upstream,
# and `errorbook sync` cannot pull from a branch that does not exist on the
# other side yet. Push the commit just made, which both creates the branch and
# sets the upstream, so sync works from the very first run on either laptop.
if [ -n "${DEMO_REMOTE:-}" ] && ! git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
  branch="$(git branch --show-current)"
  say "Remote had no branches: pushing the first commit to origin/$branch ..."
  if git push -q -u origin "$branch" 2>/dev/null; then
    say "origin/$branch is now the upstream; errorbook sync will push and pull."
  else
    say "Could not push to origin. Check you have write access, then run:"
    say "  git -C \"$PROJECT\" push -u origin $branch"
  fi
fi

# Something staged and ready, so `git commit` in the walkthrough has work to do
# and fails on the identity rather than on an empty index.
printf 'Notes for the demo.\n' > notes.md
git add notes.md

say ""
say "Demo reset. From demo/project/, with errorbook on your PATH:"
say ""
say "  1. errorbook run npm run build           missing build script"
say "  2. errorbook run node app.mjs            express imported, never installed"
say "  3. node server.js &                      take port 3000"
say "     errorbook run node server.js          then collide with it"
say "  4. errorbook run git commit -m 'demo'    git identity unset"
say ""
say "The notebook already knows 1 and 2, so those are instant hits."
say "Nobody has written up 3 or 4, so those show a miss and the save prompt."
say ""
