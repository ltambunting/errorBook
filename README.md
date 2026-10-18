# errorbook
When one teammate solves an error, nobody on the team has to solve it again.

## Before and after
Ankit hits an error nobody has written up, so errorbook explains it and offers to record what actually worked:
```
$ errorbook run git commit -m "add notes"
ERRORBOOK 27dfb3
author identity unknown
This error is not in the notebook yet.

AI suggestion - unconfirmed - cached explanation
Git will not create a commit until it knows who is making it, and no author name or email is configured for this repository. Every commit records an author, so it refuses rather than guess.
 - Set them with "git config user.name 'Your Name'" and "git config user.email you@example.com", adding --global to apply it to every repository, then commit again.
Save a new solution you actually applied? [y/n] y
Actual fix applied (Enter to cancel): git config user.name "Ankit" && git config user.email ankit@example.com
Saved. Run errorbook sync to share it.
```
Louisa, on another laptop, runs `errorbook sync` and hits the same error:
```
ERRORBOOK 27dfb3
author identity unknown

Known error - found in 12ms
1. git config user.name "Ankit" && git config user.email ankit@example.com
   fixed by ankit - just now
   confidence: unproven - confirmed 0 - rejected 0
After trying this fix: worked [y], failed [n], error returned [r], Enter to skip:
```
Her answer is what turns Ankit's guess into a confirmed fix.

## How it works
- **Wrap the command.** stdout and stderr stream through unchanged, stderr is copied, the real exit code is propagated.
- **Fingerprint the error.** Paths, home directories, timestamps, line numbers, pids, ports, versions and the identity in git's `(for <...>)` are replaced before hashing, so the same error on two machines gets the same id.
- **Look up the notebook first.** The AI is asked only when the team has nothing; a known error makes no network call.
- **Save fixes as data in the repo.** Append-only `.errorbook/<person>.jsonl`, never edited or deleted; confidence is counted at read time from confirmations, rejections and whether the error came back.
- **Share through git.** `errorbook sync` commits and pulls only `.errorbook/`, and stops on a conflict rather than guessing.

## Why not just ask an AI agent
The notebook is shared (your teammate's answer, not a generic one), persistent
(it remembers the dead ends too), instant (12ms above, not seconds), and needs
no API call for an error the team already knows.

## Install and use
Not published to npm. From a clone: `npm install && npm link`.
```
errorbook run npm run build        # run a command, explain it if it fails
errorbook run --offline <cmd>      # never call the AI, cache only
errorbook run --verbose <cmd>      # fingerprint internals and fix ids
errorbook list                     # every fix the notebook holds
errorbook sync                     # share and collect, through git
errorbook dashboard                # hit rate, top errors, hours lost
errorbook doctor                   # check the setup this project needs
errorbook scan                     # report notebook lines that look like secrets
errorbook digest [--days N]        # the dashboard's numbers as markdown
errorbook lookup [--json]          # ask the notebook about a pasted error
errorbook suggest                  # errors hitting 2+ people, and what to change
errorbook mcp                      # serve the notebook to a coding agent
```

## Two laptops
```
git init --bare /shared/team.git
DEMO_REMOTE=/shared/team.git sh demo/reset.sh    # on each laptop
cd demo/project
```
`reset.sh` builds a project in four deliberately broken states and seeds a notebook. Full walkthrough in [demo/README.md](demo/README.md).

## Environment variables
| variable | what it does |
| --- | --- |
| `ERRORBOOK_DIR` | Where the notebook lives. Default `<repo root>/.errorbook`. |
| `ERRORBOOK_AUTHOR_NAME` | Who you are in the notebook; also signs sync commits. |
| `ERRORBOOK_AUTHOR_EMAIL` | Email for sync commits; its local part is a fallback name. |
| `GEMINI_API_KEY` | Enables live AI explanations. Sent in the `x-goog-api-key` header, never in a URL. Cached explanations work without it. |
| `ERRORBOOK_AI_URL` | Overrides the AI endpoint, for a stub or proxy. No key needed. |
| `ERRORBOOK_AI_MODEL` | Gemini model. Default `gemini-3.8-flash`. |
| `DEMO_REMOTE` | Shared git URL for the two-laptop demo. |

## Safety
`scrub()` masks credentials before anything is written, printed or sent: URL
userinfo, assignments to secret-like keys, `sk-`/`ghp_`/`AKIA`/`xoxb-`/`eyJ`
prefixes, PEM blocks, and long base64 or hex runs. Author names and emails stay
readable on purpose, since the git identity error is one we explain. Notebook
text is stripped of control characters before display, so a fix written by
someone else cannot recolour your terminal or clear the screen.

## Use with a coding agent
`errorbook mcp` serves the notebook to any MCP client over stdio, read-only:
one tool, `errorbook_lookup`, that takes `error_text` and answers with the fix
a teammate recorded. The agent consults what your team already solved instead
of guessing from scratch.

Add `.mcp.json` at the project root (Claude Code and other MCP clients read it):
```json
{
  "mcpServers": {
    "errorbook": {
      "command": "errorbook",
      "args": ["mcp"]
    }
  }
}
```
Without `npm link`, use `"command": "node"` with `"args": ["bin/errorbook.js", "mcp"]`.

The server never appends to the notebook, never calls the AI, and writes
nothing to disk; `stdout` carries protocol messages only, logs go to `stderr`.
It reads the same `.errorbook/` the CLI does, so `errorbook sync` is still what
shares fixes between people.

## Honest limits
- Developed and tested on Windows only; nothing is platform-specific by design, but no other OS has been run.
- The hit rate is measured where it can be: `errorbook run` records one `lookup` line per failing command (fingerprint, outcome, author, timestamp -- no error text, no fix text), and the dashboard and the digest count those. A window with no lookup lines in it -- a notebook from before this existed, or the demo seed -- falls back to deriving the rate, counting the first solve of an error as a miss and every later encounter as a hit. Whichever method produced the number is printed next to it, and the two are never mixed in one number.
- The demo's explanations come from a committed seed cache (`src/explainer/seed-cache.json`) so it works offline; two of the four were written by hand after the Gemini free tier ran out.
- `errorbook sync` touches only `.errorbook/`, and resolves to the nearest enclosing git repository, so run it from the project you mean.

## Tests
`npm test` runs every suite with no network and no API key: capture, fingerprint,
memory, normalize, cli, dashboard, doctor, scan, digest, lookup, suggest, mcp.
