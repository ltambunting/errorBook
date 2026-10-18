// Runs a deliberately failing command through the capture module and prints
// what was captured, then exercises the retry counter.
//   node test/capture.test.js
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand, shouldInterrupt } from '../src/capture/index.js';

const NOISE_LINES = 3000; // ~120KB of stderr, well past the 64KB cap
const FAILING = [
  process.execPath,
  '-e',
  `console.log('building...');` +
    `for (let i = 0; i < ${NOISE_LINES}; i++) console.error('Error: something broke on line ' + i);` +
    `process.exit(3);`,
];

const sandbox = mkdtempSync(join(tmpdir(), 'errorbook-test-'));
const origCwd = process.cwd();
process.chdir(sandbox);
// The retry counter now resolves its path the same way the notebook does, so
// ERRORBOOK_DIR wins over the working directory. Changing directory alone is no
// longer an isolated sandbox: without this, a developer who exports
// ERRORBOOK_DIR for their own notebook runs this test against it.
process.env.ERRORBOOK_DIR = join(sandbox, '.errorbook');

// A command whose outcome we can flip, so the same key can fail then succeed.
writeFileSync('flaky.js', `import { existsSync } from 'node:fs';
if (!existsSync('pass')) { console.error('flaky: not ready'); process.exit(1); }
`);
const FLAKY = [process.execPath, 'flaky.js'];
const FLAKY_KEY = FLAKY.join(' ');
const STORE = join(sandbox, '.errorbook', 'local', 'retries.json');

let failures = 0;
const expect = (label, actual, wanted) => {
  const ok = actual === wanted;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${actual}${ok ? '' : ` (expected ${wanted})`}`);
};

try {
  let captured = null;
  const exitCode = await runCommand(FAILING, {
    onFailure: (report) => {
      captured = report;
    },
  });

  console.log('\n--- capture ---');
  console.log('exitCode:      ', exitCode);
  console.log('stderr length: ', captured ? Buffer.byteLength(captured.stderr) : '(onFailure not called)');
  console.log('stderr tail:   ', JSON.stringify(captured?.stderr.slice(-48)));
  console.log('durationMs:    ', captured?.durationMs);

  console.log('\n--- capture assertions ---');
  expect('exit code propagated', exitCode, 3);
  expect('onFailure called', captured !== null, true);
  expect('stderr trimmed to the 64KB cap', Buffer.byteLength(captured.stderr), 64 * 1024);
  expect('stderr kept the tail', captured.stderr.trimEnd().endsWith(`line ${NOISE_LINES - 1}`), true);
  expect('cwd reported', captured.cwd, sandbox);
  expect('argv reported', captured.argv.join(' '), FAILING.join(' '));

  console.log('\n--- retry counter ---');
  expect('clean slate', shouldInterrupt(FLAKY_KEY), false);
  for (let i = 1; i <= 3; i++) {
    await runCommand(FLAKY, { onFailure: () => {} });
    expect(`interrupt after ${i} failure(s)`, shouldInterrupt(FLAKY_KEY), i >= 3);
  }
  expect('count persisted', JSON.parse(readFileSync(STORE, 'utf8'))[FLAKY_KEY].count, 3);

  // Stale entries (lastAt older than 5 minutes) do not interrupt and restart at 1.
  const store = JSON.parse(readFileSync(STORE, 'utf8'));
  store[FLAKY_KEY].lastAt = Date.now() - 6 * 60 * 1000;
  writeFileSync(STORE, JSON.stringify(store));
  expect('stale entry does not interrupt', shouldInterrupt(FLAKY_KEY), false);
  await runCommand(FLAKY, { onFailure: () => {} });
  expect('stale entry restarts at 1', JSON.parse(readFileSync(STORE, 'utf8'))[FLAKY_KEY].count, 1);

  // Success clears the entry.
  writeFileSync('pass', '');
  expect('success exit code', await runCommand(FLAKY, { onFailure: () => {} }), 0);
  expect('entry cleared on success', FLAKY_KEY in JSON.parse(readFileSync(STORE, 'utf8')), false);
  expect('no interrupt after success', shouldInterrupt(FLAKY_KEY), false);

  // Signal forwarding. We emit SIGINT on this process, which is the same path a
  // real Ctrl+C takes, so the check works regardless of how the platform
  // delivers signals to the child.
  console.log('\n--- signal forwarding ---');
  writeFileSync('sleeper.js', `
    const bye = () => process.exit(43);
    process.on('SIGINT', bye);
    process.on('SIGTERM', bye);
    setTimeout(() => process.exit(0), 30000);
  `);
  const listenersBefore = process.listenerCount('SIGINT');
  const running = runCommand([process.execPath, 'sleeper.js'], { onFailure: () => {} });
  await new Promise((r) => setTimeout(r, 300));
  expect('SIGINT forwarded while running', process.listenerCount('SIGINT'), listenersBefore + 1);

  const interruptedAt = Date.now();
  process.emit('SIGINT');
  const signalExit = await running;
  expect('child did not survive the signal', signalExit !== 0, true);
  expect('waited for the child, not its 30s timer', Date.now() - interruptedAt < 10_000, true);
  expect('SIGINT handler removed after the run', process.listenerCount('SIGINT'), listenersBefore);
} finally {
  process.chdir(origCwd);
  rmSync(sandbox, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exitCode = failures === 0 ? 0 : 1;
