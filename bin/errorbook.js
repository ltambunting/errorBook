#!/usr/bin/env node
// Thin entry point: argument handling, display, lookup, the explainer and the
// save flow all live in src/cli/cli.js, so there is one code path only.
import { runCli } from '../src/cli/cli.js';

// Wait for a stream's buffered output to reach the terminal or the pipe.
const flush = (stream) =>
  new Promise((resolve) => {
    if (!stream.writableLength) return resolve();
    stream.write('', () => resolve());
  });

let code = 1;
try {
  code = await runCli(process.argv.slice(2));
} catch (err) {
  console.error(`[errorbook] ${err.message}`);
}

// Exit deliberately instead of waiting for the event loop to empty. An AI
// endpoint that never answers leaves a TCP connect attempt that the OS keeps
// open for several seconds after the answer has already been printed, and the
// shell prompt should not wait on it. Output is flushed first.
process.exitCode = code;
await flush(process.stdout);
await flush(process.stderr);
process.exit(code);

