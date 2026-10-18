// `errorbook lookup [--json]`: paste an error, get the team's fix. The same
// answer `errorbook run` prints when a command fails, asked for on its own --
// for an error from a colleague's screenshot, a CI log, or a command you have
// already finished running.
//
// Read-only and offline by construction: it calls memory.lookup() and nothing
// else. It never appends to the notebook (so asking a question cannot pollute
// the answers) and never reaches the explainer, because an AI guess is not
// what was asked for and would make a one-line query cost a network call.
//
// There is no matching logic here. The id comes from contextFromFailure(),
// which scrubs the text and fingerprints it exactly as the run path does, so a
// pasted error resolves to the same six characters the capture would have
// produced; the ranking is the notebook's own.
import nodeFs from 'node:fs';
import { contextFromFailure } from '../explainer/context.js';
import * as memory from '../memory/index.js';
import { createDisplay, relativeTime } from '../cli/display.js';

// JSON is read by other programs, so the text in it is reduced to printable
// ASCII: a notebook line is written by a person pasting from a terminal, and a
// raw escape sequence or newline inside a string is a problem for whatever
// consumes this next.
const ascii = (text) => String(text ?? '').replace(/[^\x20-\x7e]/g, ' ').replace(/[ ]{2,}/g, ' ').trim();

// A fix as JSON: the same facts the printed form shows, including the age it
// shows, so the two cannot disagree.
export function jsonFix(fix, now = Date.now()) {
  if (!fix) return null;
  return {
    fixId: ascii(fix.fixId),
    fingerprint: ascii(fix.fingerprint),
    fix: ascii(fix.fix),
    author: ascii(fix.author),
    firstSeen: ascii(fix.firstSeen),
    age: relativeTime(fix.firstSeen, now),
    confidence: ascii(fix.confidence),
    confirmations: fix.confirmations,
    rejections: fix.rejections,
    returned: Boolean(fix.returned),
  };
}

// `lookup [--json] [error text...]`. An optional `--` ends the flags, as it
// does for `run`, so an error whose text happens to begin with a dash can
// still be passed as arguments.
export function parseArgs(argv = []) {
  const rest = [];
  let json = false;
  let flags = true;
  for (const arg of argv) {
    if (flags && arg === '--') { flags = false; continue; }
    if (flags && arg === '--json') { json = true; continue; }
    rest.push(arg);
  }
  return { json, text: rest.join(' ') };
}

// Error text given as arguments wins; otherwise stdin, when something is piped
// in. A terminal is never read from: `errorbook lookup` with no input should
// say what it wants, not hang waiting for a paste that never ends.
//
// Arguments arrive already split by the shell, so a multi-line error pasted
// that way comes back joined by single spaces and fingerprints as a different
// error than the captured original. That is what the loose match is for, and
// it is why a pipe is the better way to hand over a stack trace.
export function readInput({ text, stdin = process.stdin, fs = nodeFs } = {}) {
  if (text) return text;
  if (stdin?.isTTY) return '';
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return ''; // no stdin at all
  }
}

export function runLookup(deps = {}) {
  const ui = deps.ui ?? createDisplay();
  const book = deps.memory ?? memory;
  const now = deps.now ?? Date.now();
  const { json, text: fromArgs } = parseArgs(deps.argv ?? []);
  const input = deps.text ?? readInput({ text: fromArgs, stdin: deps.stdin, fs: deps.fs });

  // contextFromFailure scrubs the text first, then fingerprints it; it returns
  // null when there is nothing in there to fingerprint.
  const event = input.trim() ? contextFromFailure({ stderr: input }) : null;
  if (!event) {
    ui.warn('errorbook lookup: no error text. Pipe it in, or pass it as arguments.');
    return 1;
  }

  const result = book.lookup(event.errorId, event.loose);
  // kind can be "exact" with no fix when an error has votes but no saved fix
  // yet; that is a miss to anyone asking this question.
  const found = result.kind !== 'none' && result.fix;
  const fixes = found ? [result.fix, ...result.alternatives] : [];

  if (json) {
    ui.line(JSON.stringify({
      kind: found ? result.kind : 'none',
      errorId: ascii(event.errorId),
      summary: ascii(event.summary),
      fix: found ? jsonFix(result.fix, now) : null,
      alternatives: result.alternatives.map((fix) => jsonFix(fix, now)),
    }, null, 2));
    return found ? 0 : 1;
  }

  ui.error(event);
  if (!found) {
    ui.line('\nno known fix');
    return 1;
  }
  // The caveat goes before the fix, so it is read first.
  if (result.kind === 'loose') ui.line('\nThis is a similar error, not an exact match. Verify that the solution applies.');
  ui.fixes(fixes, { kind: result.kind, now });
  return 0;
}
