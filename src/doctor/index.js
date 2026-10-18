// `errorbook doctor`: checks the things that make the tool, or the project it
// runs in, fail in ways that are slow to work out from the symptom. It only
// reads: no AI call, no notebook write, nothing repaired for you. Every check
// prints its own one-line fix, so the output is the instruction.
//
// Each check is a plain function over an injected deps bag and returns
// { name, status, detail, fix }, which keeps them testable without a temp repo
// per case and keeps all the printing in one place.
import nodeFs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { createDisplay } from '../cli/display.js';
import { repoRoot, dataDir } from '../paths.js';

const DEFAULT_PORT = 3000;

// --- small shared helpers --------------------------------------------------

// The lowest major a range allows. engines.node is written as ">=20", "^20.1.0"
// or "20.x" in practice, and all three carry the number we need in their first
// digits. A range too clever for that (">=18 <21", "||") reads as its first
// number, which is the conservative end, so we never claim a pass we cannot
// prove.
export function minMajor(range) {
  const found = /(\d+)/.exec(String(range ?? ''));
  return found ? Number(found[1]) : null;
}

// Keys and their raw values from a .env-shaped file. Values are read only so
// that a key present but empty can be told apart from a key that is set; they
// are never handed to the printer.
export function envKeys(text) {
  const keys = new Map();
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/^﻿/, '').trim(); // Windows editors sometimes add a hidden character
    if (!line || line.startsWith('#')) continue;
    const found = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!found) continue;
    keys.set(found[1], found[2].trim());
  }
  return keys;
}

const ok = (name, detail) => ({ name, status: 'ok', detail, fix: null });
const warn = (name, detail, fix) => ({ name, status: 'warn', detail, fix });
const fail = (name, detail, fix) => ({ name, status: 'fail', detail, fix });

function readText(fs, file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null; // missing or unreadable; every caller here treats those alike
  }
}

// --- the checks ------------------------------------------------------------

// 1. The running Node against what the project says it needs.
export function checkNode({ fs, root, nodeVersion }) {
  const running = minMajor(nodeVersion);
  const pkg = readText(fs, path.join(root, 'package.json'));
  let engines = null;
  if (pkg !== null) {
    try {
      engines = JSON.parse(pkg)?.engines?.node ?? null;
    } catch {
      return warn('node', `running ${nodeVersion}; package.json is not valid JSON, so engines.node was not read`,
        'fix the JSON syntax in package.json');
    }
  }
  const nvmrcRaw = readText(fs, path.join(root, '.nvmrc'));
  const nvmrc = nvmrcRaw === null ? null : minMajor(nvmrcRaw);
  const required = minMajor(engines);

  if (required !== null && running !== null && running < required) {
    return fail('node', `running ${nodeVersion}, but engines.node wants ${engines}`,
      `install Node ${required} or newer, then re-run`);
  }
  // A .nvmrc naming a different major than the active shell is the usual cause
  // of "it works for everyone else": the version is installed, just not the one
  // in front.
  if (nvmrc !== null && running !== null && nvmrc !== running) {
    return warn('node', `running ${nodeVersion}, but .nvmrc asks for ${nvmrc}`, 'nvm use');
  }
  if (required === null) {
    return warn('node', `running ${nodeVersion}; package.json has no engines.node to check it against`,
      'add an engines.node range to package.json');
  }
  return ok('node', `${nodeVersion} satisfies engines.node ${engines}`);
}

// 2. Keys .env.example declares that .env does not supply. Key NAMES only --
// this report gets pasted into chats and issues, so no value from either file
// is ever printed.
export function checkEnv({ fs, root }) {
  const example = readText(fs, path.join(root, '.env.example'));
  if (example === null) return ok('env', 'no .env.example, so there is nothing to compare .env against');

  const wanted = [...envKeys(example).keys()];
  if (!wanted.length) return ok('env', '.env.example declares no keys');
  const plural = (n) => (n === 1 ? 'key' : 'keys');

  const local = readText(fs, path.join(root, '.env'));
  if (local === null) {
    return fail('env', `.env is missing; .env.example declares ${wanted.length} ${plural(wanted.length)}: ${wanted.join(', ')}`,
      'copy .env.example to .env, then fill in each value');
  }
  const have = envKeys(local);
  const missing = wanted.filter((key) => !have.has(key));
  if (missing.length) {
    return fail('env', `missing from .env: ${missing.join(', ')}`,
      'add those key names to .env and give each a value');
  }
  const blank = wanted.filter((key) => have.get(key) === '');
  if (blank.length) {
    return warn('env', `present in .env but empty: ${blank.join(', ')}`, 'give each of those keys a value in .env');
  }
  return ok('env', `.env supplies all ${wanted.length} ${plural(wanted.length)} from .env.example`);
}

// How long a connect attempt is given before the port counts as unanswered.
// Loopback either answers immediately or not at all, so this only has to cover
// a loaded machine, not a network.
const PROBE_TIMEOUT_MS = 250;

// Codes that mean "this host family is not available here", as opposed to "this
// port is taken". Only these are worth retrying on the other family.
const NO_IPV6 = new Set(['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'EPROTONOSUPPORT', 'EINVAL', 'ENOTSUP']);

// Does something answer on this address? A completed TCP handshake is proof
// that the port is serving, whatever address the listener was bound to.
function canConnect(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (answer) => { socket.destroy(); resolve(answer); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

// Bind, then release immediately.
function bindAndRelease(host, port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (error) => resolve({ ok: false, code: error.code ?? 'EUNKNOWN' }));
    server.once('listening', () => server.close(() => resolve({ ok: true, code: null })));
    // exclusive, so a port another process is already sharing reports as taken
    // rather than quietly joining it.
    server.listen({ port, host, exclusive: true });
  });
}

// Is the port actually usable? Three questions, because no single one of them
// is enough:
//
// A bind to 127.0.0.1 succeeds on Windows while another process holds the same
// port on the wildcard address (0.0.0.0 / [::]), so a loopback-only bind calls
// an occupied port free. Connecting first catches exactly that case: a server
// on the wildcard answers on loopback. The wildcard bind then catches the
// reverse -- a listener that is up but not accepting, or bound to an address we
// did not ask -- and dual-stack `::` covers both families at once, with
// 0.0.0.0 for a machine built without IPv6.
//
// Free means every one of the three agreed.
export async function probePort(port, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  for (const host of ['127.0.0.1', '::1']) {
    if (await canConnect(host, port, timeoutMs)) return { free: false, code: 'EADDRINUSE' };
  }
  let bound = await bindAndRelease('::', port);
  if (!bound.ok && NO_IPV6.has(bound.code)) bound = await bindAndRelease('0.0.0.0', port);
  return bound.ok ? { free: true, code: null } : { free: false, code: bound.code };
}

// 3. The port the project serves on: PORT from .env.example when it names one,
// otherwise 3000.
export async function checkPort({ fs, root, probePort: probe = probePort }) {
  const example = readText(fs, path.join(root, '.env.example'));
  const declared = example === null ? null : envKeys(example).get('PORT');
  const port = Number(declared) || DEFAULT_PORT;
  const result = await probe(port);
  if (result.free) return ok('port', `${port} is free`);
  if (result.code === 'EADDRINUSE') {
    return warn('port', `${port} is already in use`, `stop whatever is listening on ${port}, or set PORT to a free port`);
  }
  return warn('port', `${port} could not be bound (${result.code})`,
    `check whether this machine allows binding ${port}`);
}

function defaultGitConfig(key) {
  try {
    return execFileSync('git', ['config', key], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return ''; // not a git repo, or the key is unset
  }
}

// 4. Who git thinks you are. Empty is a warning, not a failure: the notebook
// has its own fallbacks, but it will file your notes under a name no teammate
// recognises.
export function checkGit({ gitConfig }) {
  const name = String(gitConfig('user.name') ?? '').trim();
  const email = String(gitConfig('user.email') ?? '').trim();
  const empty = [!name && 'user.name', !email && 'user.email'].filter(Boolean);
  if (!empty.length) return ok('git', 'user.name and user.email are both set');
  return warn('git', `${empty.join(' and ')} ${empty.length === 1 ? 'is' : 'are'} empty, so a saved fix gets a guessed author`,
    `git config ${empty[0]} "..."`);
}

// 5. Installed packages against the lockfile. Older than the lock means the
// lock moved -- a pull, a merge, a teammate's new dependency -- and the error
// that follows is a missing module, which says nothing about why.
export function checkDeps({ fs, root }) {
  const stat = (file) => {
    try {
      return fs.statSync(path.join(root, file));
    } catch {
      return null; // missing
    }
  };
  const modules = stat('node_modules');
  const lock = stat('package-lock.json');

  if (!modules) return fail('deps', 'node_modules is missing', 'npm install');
  if (!lock) {
    return warn('deps', 'node_modules is present, but there is no package-lock.json to compare it against',
      'npm install, which writes the lockfile');
  }
  if (modules.mtimeMs < lock.mtimeMs) {
    return warn('deps', 'node_modules is older than package-lock.json', 'npm install');
  }
  return ok('deps', 'node_modules is at least as new as package-lock.json');
}

// 6. The notebook itself: readable, and every line parses. Reports file names
// and line NUMBERS only -- a corrupt line can still hold a captured error
// message, and this report gets pasted around.
export function checkNotebook({ fs, notebookDir }) {
  let names;
  try {
    names = fs.readdirSync(notebookDir);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return ok('notebook', `${notebookDir} does not exist yet, which is how a fresh checkout starts`);
    }
    return fail('notebook', `${notebookDir} cannot be read (${error.code ?? error.message})`,
      'check the permissions on the .errorbook folder');
  }
  const files = names.filter((name) => name.endsWith('.jsonl'));
  if (!files.length) return ok('notebook', `${notebookDir} is readable and holds no entries yet`);

  const bad = [];
  let lines = 0;
  for (const name of files) {
    const text = readText(fs, path.join(notebookDir, name));
    if (text === null) {
      return fail('notebook', `${name} cannot be read`, `check the permissions on ${name}`);
    }
    text.split(/\r?\n/).forEach((raw, index) => {
      const line = raw.replace(/^﻿/, '').trim();
      if (!line) return;
      lines++;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        bad.push(`${name}:${index + 1}`);
        return;
      }
      // JSON.parse also succeeds on "null", "42" and "[]", none of which is an
      // event. The loader skips those silently; here they are worth naming.
      if (!event || typeof event !== 'object' || Array.isArray(event)) bad.push(`${name}:${index + 1}`);
    });
  }
  if (bad.length) {
    return warn('notebook', `${bad.length} unreadable ${bad.length === 1 ? 'line' : 'lines'} skipped on load: ${bad.join(', ')}`,
      'delete the listed lines, then run errorbook sync');
  }
  return ok('notebook', `${files.length} ${files.length === 1 ? 'file' : 'files'}, ${lines} ${lines === 1 ? 'line' : 'lines'}, all readable`);
}

// --- the command -----------------------------------------------------------

// Runs every check and prints the report. Colour, control-character stripping
// and the stdout/stderr split all come from the shared display, so NO_COLOR and
// a redirected stdout behave here exactly as they do everywhere else.
export async function runDoctor(deps = {}) {
  const ui = deps.ui ?? createDisplay();
  const bag = {
    fs: deps.fs ?? nodeFs,
    root: deps.root ?? repoRoot(),
    nodeVersion: deps.nodeVersion ?? process.version,
    notebookDir: deps.notebookDir ?? dataDir(),
    gitConfig: deps.gitConfig ?? defaultGitConfig,
    probePort: deps.probePort ?? probePort,
  };

  const results = [
    checkNode(bag),
    checkEnv(bag),
    await checkPort(bag),
    checkGit(bag),
    checkDeps(bag),
    checkNotebook(bag),
  ];

  ui.line(`\nerrorbook doctor - ${bag.root}`);
  for (const result of results) {
    // A failing check is an error, so it goes to stderr together with its fix:
    // the problem is still visible when stdout is redirected away.
    const write = result.status === 'fail' ? ui.warn : ui.line;
    write(`${result.status.padEnd(4)} ${result.name}: ${result.detail}`);
    if (result.fix) write(`     fix: ${result.fix}`);
  }

  const count = (status) => results.filter((r) => r.status === status).length;
  const failures = count('fail');
  const warnings = count('warn');
  ui.line(`\n${results.length} checks: ${count('ok')} ok, ${warnings} ${warnings === 1 ? 'warning' : 'warnings'}, ${failures} ${failures === 1 ? 'failure' : 'failures'}`);
  return failures ? 1 : 0;
}
