// All output is plain ASCII and left-aligned: no box drawing, no column
// padding, nothing that assumes a terminal width. Long lines are left to the
// terminal to soft-wrap, which reads correctly however narrow it is.

// Whole days, so "a year ago" is 365 days rather than an averaged 365.25 that
// renders two calendar years as "1 year ago".
const UNITS = [
  ['year', 365 * 86400],
  ['month', 30 * 86400],
  ['week', 7 * 86400],
  ['day', 86400],
  ['hour', 3600],
  ['minute', 60],
];

// "2 minutes ago". A timestamp written on a teammate's machine can be slightly
// ahead of ours, so the future reads as "just now" rather than "-1 minutes".
export function relativeTime(iso, now = Date.now()) {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return null;
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  for (const [name, size] of UNITS) {
    if (seconds >= size) {
      const n = Math.floor(seconds / size);
      return `${n} ${name}${n === 1 ? '' : 's'} ago`;
    }
  }
  return 'just now';
}

// Storage keeps the slug that names the file ("ankit-aggarwal"); a reader only
// needs the first part of it.
export function displayName(author) {
  return String(author ?? '').split('-')[0] || 'someone';
}

export function createDisplay(output = process.stdout, errors = process.stderr) {
  const colors = output.isTTY && !process.env.NO_COLOR;
  // Strip control characters so a fix saved by a teammate cannot recolour the
  // terminal, clear the screen or overwrite the line above. Tabs and newlines
  // are kept.
  const safe = s => String(s).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g,'');
  const line = s => output.write(safe(s)+'\n');
  // Usage and errors belong on stderr, so `errorbook list | ...` pipes only the
  // notebook and a failure is still visible when stdout is redirected.
  const warn = s => errors.write(safe(s)+'\n');
  const heading = s => output.write(colors ? `\x1b[36;1m${safe(s)}\x1b[0m\n` : safe(s)+'\n');
  // Keep the later lines of a multi-line fix under its own number, instead of
  // flush left where they read as separate solutions.
  const hang = (text, pad) => String(text).split('\n').join('\n'+pad);
  return {
    line,
    warn,
    error(event) { heading(`\nERRORBOOK ${event.errorId}`); line(event.summary || event.normalizedError); },
    // The headline of the whole demo: that the answer came from the team's
    // notebook, and how long that took. `kind` omitted means "not a match"
    // (errorbook list), so no heading is claimed at all.
    fixes(fixes, { kind = null, lookupMs = null, verbose = false, now = Date.now() } = {}) {
      if (kind) {
        const found = lookupMs === null ? '' : ` - found in ${lookupMs}ms`;
        heading(`\n${kind === 'loose' ? 'Similar error' : 'Known error'}${found}`);
      }
      fixes.forEach((fix,i)=>{
        line(`${i+1}. ${hang(fix.fix,'   ')}`);
        const when = relativeTime(fix.firstSeen, now);
        line(`   fixed by ${displayName(fix.author)}${when ? ` - ${when}` : ''}`);
        line(
          `   confidence: ${fix.confidence}` +
          ` - confirmed ${fix.confirmations} - rejected ${fix.rejections}` +
          `${fix.returned ? ' - error returned' : ''}` +
          `${verbose ? ` - fix ${fix.fixId}` : ''}`,
        );
      });
    },
    explanation(result) {
      if (result.status!=='ok') { line(`\nAI explanation unavailable: ${result.message}`); return; }
      heading(`\nAI suggestion - unconfirmed - ${result.source==='cache'?'cached explanation':'live response'}`);
      line(hang(result.value.explanation,'')); result.value.suggestedSteps.forEach(s=>line(` - ${hang(s,'   ')}`)); result.value.caveats.forEach(s=>line(` Note: ${hang(s,'       ')}`));
    }
  };
}
