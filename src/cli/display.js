export function createDisplay(output = process.stdout) {
  const colors = output.isTTY && !process.env.NO_COLOR;
  const safe = s => String(s).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g,'');
  const line = s => output.write(safe(s)+'\n');
  const heading = s => output.write(colors ? `\x1b[36;1m${safe(s)}\x1b[0m\n` : safe(s)+'\n');
  return {
    line,
    error(event) { heading(`\nERRORBOOK · ${event.errorId}`); line(event.summary || event.normalizedError); },
    fixes(fixes,kind='exact') {
      heading(`\n${kind==='loose'?'Similar error':'Exact match'} · ${fixes.length} solution${fixes.length===1?'':'s'}`);
      fixes.forEach((fix,i)=>{
        line(`${i+1}. ${fix.fix}`);
        line(`   fixed by ${fix.author} · confirmed ${fix.confirmations} times · rejected ${fix.rejections} times`);
        line(`   confidence: ${fix.confidence}${fix.returned?' · error returned':''} · fix ${fix.fixId}`);
      });
    },
    explanation(result) {
      if (result.status!=='ok') { line(`\nAI explanation unavailable: ${result.message}`); return; }
      heading(`\nAI suggestion · unconfirmed · ${result.source==='cache'?'cached explanation':'live response'}`);
      line(result.value.explanation); result.value.suggestedSteps.forEach(s=>line(` • ${s}`)); result.value.caveats.forEach(s=>line(` Note: ${s}`));
    }
  };
}
