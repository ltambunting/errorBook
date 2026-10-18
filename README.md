# errorbook

A team's memory of its own errors. Run a command through `errorbook`; when it
fails, errorbook fingerprints the error, looks it up in a notebook your team
shares through git, and tells you what worked last time.

```
$ errorbook run npm run build
npm error Missing script: "build"

[errorbook] Command failed with exit code 1 (910ms)

ERRORBOOK 6ce249
npm error missing script: "build"

Known error - found in 11ms
1. Add a build script to package.json: "build": "tsc -p ."
   fixed by ankit - 1 week ago
   confidence: medium - confirmed 1 - rejected 0
2. Reinstall node_modules
   fixed by louisa - 1 week ago
   confidence: low - confirmed 0 - rejected 1
```

Node 20+. The only runtime dependency is `picocolors`.

## Commands

```
errorbook run [--offline] [--verbose] [--] <command> [args...]
errorbook list [--verbose]
errorbook sync
errorbook dashboard [--no-open]
```

- **run** — run a command, and explain it if it fails. `--offline` skips the AI
  and uses only what is cached. `--verbose` adds the fingerprint internals and
  fix ids.
- **list** — every fix the notebook holds.
- **sync** — share your notes and collect your teammates', through git. Only
  ever touches `.errorbook/`.
- **dashboard** — writes a self-contained HTML page with the team's data
  embedded and opens it. Hit rate, top errors, hours lost, a fortnight's
  timeline.

## How it works

1. **capture** runs your command with its output untouched, and keeps a copy of
   stderr.
2. **fingerprint** normalises that text — paths, timestamps, line numbers, pids,
   ports, versions — and hashes it to a short id. The same error on two machines
   gets the same id.
3. **memory** is an append-only JSONL file per person under `.errorbook/`.
   Nothing is ever edited or deleted; confidence is counted at read time.
4. **explainer** asks an AI only when the notebook has nothing, and caches the
   answer.

Credentials are scrubbed before anything is stored, printed or sent anywhere.

## Environment variables

| variable | what it does |
| --- | --- |
| `GEMINI_API_KEY` | Google Gemini API key, used by the explainer. Without it the AI step is skipped and only cached explanations are used. Sent in the `x-goog-api-key` header, never in a URL. |
| `ERRORBOOK_AI_MODEL` | Gemini model to use. Default `gemini-3.8-flash`. |
| `ERRORBOOK_AI_URL` | Overrides the AI endpoint entirely, for a local stub or a proxy. When set, no API key is required. |
| `ERRORBOOK_DIR` | Where the notebook lives. Default `<repo root>/.errorbook`. |
| `ERRORBOOK_AUTHOR_NAME` | Who you are in the notebook, and how `errorbook sync` signs its commits. Takes precedence over everything below. |
| `ERRORBOOK_AUTHOR` | The older name for the same thing; still honoured, one rung down. |
| `ERRORBOOK_AUTHOR_EMAIL` | Email for `errorbook sync` commits. Its local part is also used as your notebook name if nothing above is set. |

Your notebook name is resolved in that order, then `git config user.name`, then
the local part of `git config user.email`, and only then `someone`. Whatever it
lands on is slugified, so `Ankit Aggarwal` files notes under `ankit-aggarwal`.
| `NO_COLOR` | Any non-empty value turns colour off. Colour is also off automatically when output is not a terminal. |

Set the key in your shell, not in a file in the repo:

```
export GEMINI_API_KEY=...        # bash/zsh
$env:GEMINI_API_KEY = '...'      # PowerShell
```

## Where things are written

| path | git | what |
| --- | --- | --- |
| `.errorbook/<author>.jsonl` | committed | the shared notebook |
| `.errorbook/local/` | ignored | retry counter, explanation cache, generated dashboard |
| `src/explainer/seed-cache.json` | committed | explanations for the demo's errors, so it works offline |

## The demo

Four deliberately broken states, a seeded notebook and a reset script:

```
sh demo/reset.sh        # or: pwsh demo/reset.ps1
cd demo/project
```

See [demo/README.md](demo/README.md).

## Tests

```
npm test
```

Six suites: capture, fingerprint, memory, normalize, cli, dashboard. The AI is
never called from the tests.
