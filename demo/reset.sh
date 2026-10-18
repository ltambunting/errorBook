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

rm -rf "$PROJECT"
mkdir -p "$PROJECT"
cd "$PROJECT"

# --- 1. missing build script, and 2. a module that is never installed ------
cp "$DEMO/template/package.json" package.json
cp "$DEMO/template/app.mjs" app.mjs
cp "$DEMO/template/server.js" server.js
cat > .gitignore <<'IGNORE'
node_modules/
.errorbook/local/
IGNORE

# --- the team's notebook ---------------------------------------------------
node "$DEMO/template/seed.mjs" "$PROJECT/.errorbook"

# --- 4. git identity unset -------------------------------------------------
# The identity is set to the empty string rather than unset. Unsetting it is not
# enough: git falls back to your global user.name and the commit simply
# succeeds on any configured machine. (user.useConfigOnly only stops git
# guessing from the hostname; it does not stop the global config.) An empty
# local value overrides the global one and produces the real
# "Author identity unknown", without touching your own settings.
git init -q .
git config user.useConfigOnly true
git config user.name ""
git config user.email ""

# One seed commit, made with an explicit identity so that creating it does not
# hit the very error we are about to demonstrate.
git add -A
git -c user.name=seed -c user.email=seed@example.com commit -q -m "errorbook demo project"

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
