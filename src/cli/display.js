// All output is plain ASCII and left-aligned: no box drawing, no column
// padding, nothing that assumes a terminal width. Long lines are left to the
// terminal to soft-wrap, which reads correctly however narrow it is.
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
    // `kind` omitted means "no match to report" (errorbook list), so the
    // exact/similar heading is left off entirely.
    fixes(fixes,kind=null) {
      if (kind) heading(`\n${kind==='loose'?'Similar error':'Exact match'} - ${fixes.length} solution${fixes.length===1?'':'s'}`);
      fixes.forEach((fix,i)=>{
        line(`${i+1}. ${hang(fix.fix,'   ')}`);
        line(`   fixed by ${fix.author} - confirmed ${fix.confirmations} times - rejected ${fix.rejections} times`);
        line(`   confidence: ${fix.confidence}${fix.returned?' - error returned':''} - fix ${fix.fixId}`);
      });
    },
    explanation(result) {
      if (result.status!=='ok') { line(`\nAI explanation unavailable: ${result.message}`); return; }
      heading(`\nAI suggestion - unconfirmed - ${result.source==='cache'?'cached explanation':'live response'}`);
      line(hang(result.value.explanation,'')); result.value.suggestedSteps.forEach(s=>line(` - ${hang(s,'   ')}`)); result.value.caveats.forEach(s=>line(` Note: ${hang(s,'       ')}`));
    }
  };
}
