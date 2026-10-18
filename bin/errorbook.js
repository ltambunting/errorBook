#!/usr/bin/env node
import pc from 'picocolors';
import { runCommand, shouldInterrupt } from '../src/capture/index.js';
import { fingerprint, scrub } from '../src/fingerprint/index.js';
import { lookup } from '../src/memory/index.js';

const USAGE = `${pc.bold('errorbook')} run <command...>

  errorbook run npm install
  errorbook run node script.js
`;

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// One line per fix: what to do, who found it, how well it is holding up.
function describe(fix) {
  return (
    `${fix.fix}\n` +
    pc.dim(`              by ${fix.author}  ${fix.confidence}  ${plural(fix.confirmations, 'confirmation')}`)
  );
}

// Report a failure, and say whether the notebook has seen it before. Lookup and
// display only: nothing is saved, and nothing prompts to save yet.
function onFailure({ command, stderr, exitCode, cwd, durationMs }) {
  // Mask credentials before the text is fingerprinted or printed.
  const { id, loose, summary } = fingerprint(scrub(stderr));

  console.log(
    pc.red(`\n[errorbook] "${command}" failed with exit code ${exitCode}`) +
      pc.dim(` (${durationMs}ms, ${cwd})`),
  );
  console.log(pc.dim(`[errorbook] captured ${Buffer.byteLength(stderr)} bytes of stderr`));
  console.log(
    `[errorbook] id ${pc.bold(pc.cyan(id ?? '-'))}` +
      pc.dim(`  lang ${loose.lang}  type ${loose.errorType ?? '-'}`),
  );
  if (summary) console.log(pc.dim(`[errorbook] ${summary}`));

  const startedAt = performance.now();
  const { kind, fix, alternatives } = lookup(id, loose);
  const lookupMs = Math.round(performance.now() - startedAt);

  if (kind !== 'none' && fix) {
    const label = kind === 'exact' ? 'seen this exact error before' : 'seen a similar error before';
    console.log(pc.green(`[errorbook] ${label}`) + pc.dim(` (${kind} match in ${lookupMs}ms)`));
    console.log(`[errorbook] fix:      ${describe(fix)}`);
    if (alternatives.length > 0) {
      console.log(pc.dim(`[errorbook] ${plural(alternatives.length, 'alternative')}:`));
      for (const alt of alternatives) console.log(`[errorbook]   also:   ${describe(alt)}`);
    }
  }

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
