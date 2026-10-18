# errorbook demo

A small Node project kept in four deliberately broken states, each one
triggering a different fingerprinted error. The team's notebook is seeded, so
two of the four are answered instantly and two are not answered at all.

## Setup

```
sh demo/reset.sh          # or: pwsh demo/reset.ps1
cd demo/project
```

`reset.sh` can be run as often as you like; it rebuilds `demo/project/` from
scratch every time. `demo/template/` is the source of truth, and
`demo/project/` is gitignored, including the throwaway git repository inside
it.

The commands below assume `errorbook` is on your PATH (`npm link` from the repo
root). Otherwise use `node ../../bin/errorbook.js` in its place.

## The walkthrough

### 1. A known error, with two competing fixes

```
errorbook run npm run build
```

`package.json` has no `build` script. Fingerprint `6ce249`, which the notebook
knows:

```
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

Ankit's fix is first because Louisa confirmed it. Louisa's own guess is still
shown, ranked below and marked `low`, because Ankit tried it and rejected it. A
dead end someone has already walked down is worth knowing about.

### 2. A known error in a different language

```
errorbook run node app.mjs
```

`app.mjs` imports `express`, which was never installed. Fingerprint `fb4768`,
also in the notebook, with Louisa's fix confirmed by Ankit.

### 3. An error nobody has written up

```
node server.js &
errorbook run node server.js
```

The first server takes port 3000; the second collides with it. Fingerprint
`28b25a`, which is **not** in the notebook, so you get the AI fallback and then
the prompt to save what actually worked. Save something, run it again, and the
same command is now an exact match.

Stop the background server when you are done, or just run `reset.sh`, which
frees the port for you.

### 4. The git identity error

```
errorbook run git commit -m "demo"
```

Fingerprint `b540a5`. Also unknown, so this is the second chance to show the
save flow. Note that `Author identity unknown` and the suggested
`git config --global user.name` lines survive unredacted: the credential
scrubber is anchored to `authorization`, never bare `auth`, precisely so this
error stays readable.

### Afterwards

```
errorbook list                 # everything the notebook holds
errorbook run --verbose npm run build   # fingerprint internals and fixIds
errorbook dashboard            # the team view, opens in a browser
```

## What is in the seeded notebook

Two teammates, `ankit-aggarwal` and `louisa-tambunting`, and five real
fingerprints over the last two weeks. Every id was captured from a genuine
failure, not invented:

| error | id | state |
| --- | --- | --- |
| npm missing `build` script | `6ce249` | two competing fixes, one confirmed, one rejected |
| `express` not installed | `fb4768` | one fix, confirmed |
| `TypeError` in `cart.js` | `204e89` | confirmed, then the error came back |
| postgres `ECONNREFUSED` | `65975b` | one fix, confirmed |
| eslint config missing | `20116d` | one fix, nobody has checked it |

`28b25a` (port in use) and `b540a5` (git identity) are deliberately absent.

Timestamps are generated relative to the day you run `reset.sh`, so the
dashboard's two-week timeline is never stale.

The highest confidence reachable here is `medium`: `high` needs two different
people to confirm the same fix, and the seed has only the two authors asked
for. Add a third teammate's confirmation if you want to show `high`.
