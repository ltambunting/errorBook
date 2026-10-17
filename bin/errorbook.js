#!/usr/bin/env node
import pc from 'picocolors';
import { runCommand, shouldInterrupt } from '../src/capture/index.js';

const USAGE = `${pc.bold('errorbook')} run <command...>

  errorbook run npm install
  errorbook run node script.js
`;

// Stub: the capture module only reports failures, it does not act on them.
function onFailure({ command, stderr, exitCode, cwd, durationMs }) {
  console.log(
    pc.red(`\n[errorbook] "${command}" failed with exit code ${exitCode}`) +
      pc.dim(` (${durationMs}ms, ${cwd})`),
  );
  console.log(pc.dim(`[errorbook] captured ${Buffer.byteLength(stderr)} bytes of stderr`));
  if (shouldInterrupt(command)) {
    console.log(pc.yellow('[errorbook] this command has failed 3+ times in the last 5 minutes'));
  }
}

async function main(args) {
  const [subcommand, ...rest] = args;

  if (!subcommand || subcommand === '-h' || subcommand === '--help') {
    console.log(USAGE);
    return subcommand ? 0 : 1;
  }

  if (subcommand !== 'run') {
    console.error(pc.red(`unknown command: ${subcommand}\n`));
    console.error(USAGE);
    return 1;
  }

  if (rest.length === 0) {
    console.error(pc.red('errorbook run: no command given\n'));
    console.error(USAGE);
    return 1;
  }

  return runCommand(rest, { onFailure });
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  console.error(pc.red(`[errorbook] ${err.message}`));
  process.exitCode = 1;
}
