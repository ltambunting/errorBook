# Builds demo/project/ in all four broken states, so the walkthrough in
# README.md can be run again from scratch. Safe to run any number of times.
# The PowerShell twin of reset.sh; see that file for why each step is needed.
#
#   pwsh demo/reset.ps1
$ErrorActionPreference = 'Stop'

$Demo = Split-Path -Parent $MyInvocation.MyCommand.Path
$Project = Join-Path $Demo 'project'

# --- 3. port 3000: let go of it, so the next demo can take it again ---------
try {
  Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction Stop |
    Select-Object -ExpandProperty OwningProcess -Unique |
    ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
} catch {
  # Nothing is listening, or the cmdlet is unavailable. Either is fine.
}

if (Test-Path $Project) { Remove-Item -Recurse -Force $Project }
New-Item -ItemType Directory -Force $Project | Out-Null
Push-Location $Project
try {
  # --- 1. missing build script, and 2. a module that is never installed ----
  Copy-Item (Join-Path $Demo 'template/package.json') 'package.json'
  Copy-Item (Join-Path $Demo 'template/app.mjs') 'app.mjs'
  Copy-Item (Join-Path $Demo 'template/server.js') 'server.js'
  "node_modules/`n.errorbook/local/" | Set-Content -NoNewline -Path '.gitignore'

  # --- the team's notebook ------------------------------------------------
  node (Join-Path $Demo 'template/seed.mjs') (Join-Path $Project '.errorbook')

  # --- 4. git identity unset ----------------------------------------------
  # Empty, not unset: an unset local identity falls back to your global one and
  # the commit would succeed. See reset.sh for the full explanation.
  git init -q .
  git config user.useConfigOnly true
  git config user.name ""
  git config user.email ""

  git add -A
  git -c user.name=seed -c user.email=seed@example.com commit -q -m "errorbook demo project"

  # Something staged, so `git commit` fails on the identity, not an empty index.
  Set-Content -Path 'notes.md' -Value 'Notes for the demo.'
  git add notes.md
} finally {
  Pop-Location
}

@"

Demo reset. From demo/project/, with errorbook on your PATH:

  1. errorbook run npm run build           missing build script
  2. errorbook run node app.mjs            express imported, never installed
  3. Start-Process node server.js          take port 3000
     errorbook run node server.js          then collide with it
  4. errorbook run git commit -m 'demo'    git identity unset

The notebook already knows 1 and 2, so those are instant hits.
Nobody has written up 3 or 4, so those show a miss and the save prompt.

"@ | Write-Host
