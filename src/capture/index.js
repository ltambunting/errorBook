import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { mkdirSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { join, dirname, extname, delimiter, isAbsolute } from 'node:path';

const STDERR_CAP = 64 * 1024;
const RETRY_WINDOW_MS = 5 * 60 * 1000;
const INTERRUPT_AT = 3;
const FORWARDED_SIGNALS = ['SIGINT', 'SIGTERM'];

// --- stderr tail buffer ---------------------------------------------------

function createTailBuffer(cap) {
  const chunks = [];
  let total = 0;
  return {
    push(chunk) {
      chunks.push(chunk);
      total += chunk.length;
      while (total > cap) {
        const first = chunks[0];
        if (total - first.length >= cap) {
          chunks.shift();
          total -= first.length;
        } else {
          chunks[0] = first.subarray(total - cap);
          total = cap;
        }
      }
    },
    toString() {
      return Buffer.concat(chunks, total).toString('utf8');
    },
  };
}

// --- retry counter --------------------------------------------------------

function storePath() {
  return join(process.cwd(), '.errorbook', 'local', 'retries.json');
}

function readStore() {
  try {
    const parsed = JSON.parse(readFileSync(storePath(), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // Missing or corrupt store: start clean rather than failing the run.
    return {};
  }
}

function writeStore(store) {
  const file = storePath();
  const dir = dirname(file);
  try {
    mkdirSync(dir, { recursive: true });
    // Keep local state out of git even if the repo's .gitignore drifts.
    writeFileSync(join(dir, '.gitignore'), '*\n');
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`);
    renameSync(tmp, file);
  } catch {
    // The counter is advisory; never let a write failure break the run.
  }
}

function isStale(entry, now) {
  return !entry || typeof entry.lastAt !== 'number' || now - entry.lastAt > RETRY_WINDOW_MS;
}

function recordFailure(command) {
  const now = Date.now();
  const store = readStore();
  const prev = store[command];
  const count = isStale(prev, now) ? 1 : (prev.count || 0) + 1;
  store[command] = { count, lastAt: now };
  writeStore(store);
  return count;
}

function recordSuccess(command) {
  const store = readStore();
  if (!(command in store)) return;
  delete store[command];
  writeStore(store);
}

export function shouldInterrupt(command) {
  const entry = readStore()[command];
  if (isStale(entry, Date.now())) return false;
  return (entry.count || 0) >= INTERRUPT_AT;
}

// --- command resolution ---------------------------------------------------

// Windows needs the command resolved by hand: `npm` is really `npm.cmd`, and a
// batch shim can only be launched through cmd.exe. We avoid `shell: true`
// because Node does not quote the command path, which breaks on paths with
// spaces (C:\Program Files\nodejs\node.exe).
function resolveWindowsCommand(command) {
  const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const hasDir = isAbsolute(command) || command.includes('/') || command.includes('\\');
  const bases = hasDir
    ? [command]
    : [
        command,
        ...(process.env.Path || process.env.PATH || '')
          .split(delimiter)
          .filter(Boolean)
          .map((dir) => join(dir, command)),
      ];

  for (const base of bases) {
    const candidates = extname(base)
      ? [base, ...exts.map((ext) => base + ext)]
      : exts.map((ext) => base + ext);
    for (const candidate of candidates) {
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

const CMD_META = /[()%!^"<>&|;,`*? [\]]/g;

// cmd.exe treats a caret-escaped quote as a literal character, so the command
// path cannot be quoted -- its spaces and metacharacters get carets instead.
function escapeCmdCommand(file) {
  return String(file).replace(CMD_META, '^$&');
}

// Arguments are quoted (those quotes survive to the child, which parses them
// by the usual Windows rules) and then fully caret-escaped for cmd.
function escapeCmdArgument(arg) {
  const escaped = String(arg)
    .replace(/(\\*)"/g, '$1$1\\"')
    .replace(/(\\*)$/, '$1$1');
  return `"${escaped}"`.replace(CMD_META, '^$&');
}

function resolveSpawn(argv) {
  if (process.platform !== 'win32') {
    return { file: argv[0], args: argv.slice(1), options: {} };
  }

  const resolved = resolveWindowsCommand(argv[0]);
  const ext = resolved ? extname(resolved).toLowerCase() : '';
  if (ext === '.cmd' || ext === '.bat') {
    const line = [escapeCmdCommand(resolved), ...argv.slice(1).map(escapeCmdArgument)].join(' ');
    return {
      file: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', `"${line}"`],
      options: { windowsVerbatimArguments: true },
    };
  }
  return { file: resolved || argv[0], args: argv.slice(1), options: {} };
}

// --- runner ---------------------------------------------------------------

function exitCodeFor(code, signal) {
  if (code !== null && code !== undefined) return code;
  const number = signal ? constants.signals[signal] : undefined;
  return number ? 128 + number : 1;
}

export function runCommand(argv, { onFailure } = {}) {
  if (!Array.isArray(argv) || argv.length === 0) {
    return Promise.reject(new Error('runCommand: argv must be a non-empty array'));
  }

  const command = argv.join(' ');
  const cwd = process.cwd();
  const startedAt = Date.now();
  const tail = createTailBuffer(STDERR_CAP);

  const { file, args, options } = resolveSpawn(argv);
  const child = spawn(file, args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    ...options,
  });

  // Chunks go through unmodified, so colors and progress bars survive.
  child.stdout.on('data', (chunk) => process.stdout.write(chunk));
  child.stderr.on('data', (chunk) => {
    tail.push(chunk);
    process.stderr.write(chunk);
  });

  // Interactive prompts: hand the user's keystrokes to the child, and ignore
  // EPIPE if the child stops reading first.
  child.stdin.on('error', () => {});
  process.stdin.pipe(child.stdin);

  const handlers = FORWARDED_SIGNALS.map((signal) => [
    signal,
    () => {
      // Let the child decide how to die; we exit only once it has.
      try {
        child.kill(signal);
      } catch {
        /* already gone */
      }
    },
  ]);
  for (const [signal, handler] of handlers) process.on(signal, handler);

  const cleanup = () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
    process.stdin.unpipe(child.stdin);
    process.stdin.pause();
  };

  return new Promise((resolve, reject) => {
    let settled = false;

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    });

    // 'close', not 'exit', so stdout/stderr are fully drained first.
    child.on('close', async (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();

      const exitCode = exitCodeFor(code, signal);
      if (exitCode === 0) {
        recordSuccess(command);
        resolve(exitCode);
        return;
      }

      recordFailure(command);
      if (typeof onFailure === 'function') {
        try {
          await onFailure({
            command,
            argv,
            stderr: tail.toString(),
            exitCode,
            cwd,
            durationMs: Date.now() - startedAt,
          });
        } catch (err) {
          reject(err);
          return;
        }
      }
      resolve(exitCode);
    });
  });
}
