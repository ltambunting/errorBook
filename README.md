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
- **Look up the notebook first.** The AI is asked only when the team has nothing; a known error makes no network call. Each lookup is recorded, so the hit rate is counted rather than inferred.
- **Save fixes as data in the repo.** Append-only `.errorbook/<person>.jsonl`, never edited or deleted; confidence is counted at read time from confirmations, rejections and whether the error came back.
- **Share through git.** `errorbook sync` commits and pulls only `.errorbook/`, and stops on a conflict rather than guessing.
- **Why not just ask an agent.** The notebook is shared (your teammate's answer, not a generic one), it keeps the dead ends too, and it needs no API call for an error the team already knows.

## Install and use
Not published to npm. From a clone: `npm install && npm link`.
```
errorbook run npm run build        # run a command, explain it if it fails
errorbook run --offline <cmd>      # never call the AI, cache only
errorbook run --verbose <cmd>      # fingerprint internals and fix ids
errorbook list [--verbose]         # every fix the notebook holds
errorbook sync                     # share and collect, through git
errorbook dashboard [--no-open]    # hit rate, top errors, hours lost
errorbook doctor                   # node, .env keys, port, git identity, deps
errorbook scan [dir]               # notebook lines that still look like secrets
errorbook digest [--days N] [--out FILE]    # the dashboard's numbers as markdown
errorbook lookup [--json] [error text...]   # ask the notebook about an error
errorbook lookup < error.txt       #   same, piped: a stack trace or a CI log
errorbook suggest                  # errors hitting 2+ people, and what to change
errorbook mcp                      # serve the notebook to a coding agent
```
`doctor`, `scan`, `digest`, `lookup` and `suggest` only read: no AI call, nothing
appended. `suggest` is a lookup table on the error type -- missing script, module
not found, port in use, plus one rule that reads the scrubbed text for an absent
env key's name -- not a diagnosis.

## Two laptops
`git init --bare /shared/team.git`, then on each laptop
`DEMO_REMOTE=/shared/team.git sh demo/reset.sh` and `cd demo/project`. `reset.sh`
builds a project in four deliberately broken states and seeds a notebook. Full
walkthrough in [demo/README.md](demo/README.md).

## Environment variables
| variable | what it does |
| --- | --- |
| `ERRORBOOK_DIR` | Where the notebook lives. Default `<repo root>/.errorbook`. |
| `ERRORBOOK_AUTHOR_NAME` | Who you are in the notebook; also signs sync commits. |
| `ERRORBOOK_AUTHOR_EMAIL` | Email for sync commits; its local part is a fallback name. |
| `GEMINI_API_KEY` | Enables live AI explanations. Sent in the `x-goog-api-key` header, never in a URL. Cached explanations work without it. |
| `ERRORBOOK_AI_URL`, `ERRORBOOK_AI_MODEL` | Override the AI endpoint (for a stub or proxy; no key needed) and the Gemini model. Default model `gemini-3.8-flash`. |
| `DEMO_REMOTE` | Shared git URL for the two-laptop demo. |

## Safety
`scrub()` masks credentials before anything is written, printed or sent: URL
userinfo, assignments to secret-like keys, `sk-`/`ghp_`/`AKIA`/`xoxb-`/`eyJ`
prefixes, PEM blocks, and long base64 or hex runs. `errorbook scan` re-runs that
same `scrub()` over the notebook rather than keeping a second set of patterns,
so what it finds is a line written before a rule existed or edited by hand; it
prints only masked text and never rewrites one. Author names and emails stay
readable on purpose, since the git identity error is one we explain. Notebook
text is stripped of control characters before display, so someone else's fix
cannot recolour your terminal or clear the screen.

## Use with a coding agent
`errorbook mcp` serves the notebook over stdio, read-only: one tool,
`errorbook_lookup`, taking `error_text` and answering with a teammate's fix. Add
`.mcp.json` at the project root:
```json
{ "mcpServers": { "errorbook": { "command": "errorbook", "args": ["mcp"] } } }
```
Without `npm link`, use `"command": "node"` and `"args": ["bin/errorbook.js", "mcp"]`.
The server never appends, never calls the AI and writes nothing to disk; `stdout`
carries protocol messages only, logs go to `stderr`.

## Honest limits
- Developed and tested on Windows only; nothing is platform-specific by design, but no other OS has been run.
- The MCP server has only been tried with Claude Code. It speaks stdio JSON-RPC, so other clients are expected to work, but none has been tested.
- The hit rate is measured once the CLI has recorded lookups: `errorbook run` appends one `lookup` line per failing command (fingerprint, outcome, author, timestamp -- no error text, no fix text). A notebook with none of those, including the demo seed, falls back to deriving it, counting the first solve of an error as a miss and every later encounter as a hit. The dashboard and the digest both state which method produced the number, and never mix the two in one number.
- The demo's explanations come from a committed seed cache (`src/explainer/seed-cache.json`) so it works offline; two of the four were written by hand after the Gemini free tier ran out.
- `errorbook sync` touches only `.errorbook/`, and resolves to the nearest enclosing git repository, so run it from the project you mean.

## Tests
`npm test` runs twelve suites with no network and no API key: 271 named tests -- cli 50, dashboard 39, doctor 32, digest 25, mcp 25, scan 24, lookup 20, normalize 20, suggest 19, memory 17 -- plus capture's 20 assertions and fingerprint's 58.
