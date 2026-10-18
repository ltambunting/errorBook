import { runCommand, shouldInterrupt } from '../capture/index.js';
import * as memory from '../memory/index.js';
import { sync } from '../sync/index.js';
import { contextFromFailure } from '../explainer/context.js';
import { createExplainer } from '../explainer/explainer.js';
import { defaultCacheFile } from '../explainer/cache.js';
import { createDisplay } from './display.js';
import { createPrompts } from './prompts.js';
import { writeDashboard, openInBrowser } from '../dashboard/index.js';
import { runDoctor } from '../doctor/index.js';
import { runScan } from '../scan/index.js';
import { runDigest } from '../digest/index.js';
import { runLookup } from '../lookup/index.js';
import { runSuggest } from '../suggest/index.js';
import { runMcp } from '../mcp/index.js';

// One auto-confirm per fix per person: somebody who has already voted on this
// fix by hand is not asked again through the back door, and nobody's silence
// gets counted twice.
function hasVoted(book, author, fixId) {
  try {
    return book.loadAll().some(e => e?.fixId === fixId && e.author === author && (e.type === 'confirmed' || e.type === 'rejected'));
  } catch { return false; }
}

// The fix a developer was shown last time and said nothing about, and the
// evidence that it worked: the same command, run again, exiting 0 inside the
// window. The vote goes through the ordinary append path, so it counts exactly
// like one somebody typed -- the only difference is that nobody had to.
//
// Everything here is best-effort. The command the developer ran has already
// succeeded, so a notebook that cannot be read or written changes nothing but
// this courtesy.
async function autoConfirm(book, ui, pending) {
  try {
    if (!pending) return;
    const expired = book.isPendingExpired?.(pending) ?? true;
    book.dropPending?.(pending.command); // consumed either way: one chance per entry
    if (expired) return;
    const author = book.me();
    if (author !== pending.author) return; // a different person's silence proves nothing
    const result = await book.lookup(pending.fingerprint);
    const fix = [result.fix, ...result.alternatives].find(f => f?.fixId === pending.fixId);
    if (!fix || fix.author === author) return; // withdrawn, or your own fix after all
    if (hasVoted(book, author, pending.fixId)) return;
    await book.append({ type: 'confirmed', fingerprint: pending.fingerprint, fixId: pending.fixId, author });
    ui.line(`Recorded: the fix for ${pending.fingerprint} appears to have worked.`);
  } catch { /* never speak up, and never fail, on a command that passed */ }
}

export async function runCli(args, deps = {}) {
  const ui = deps.ui ?? createDisplay(), prompts = deps.prompts ?? createPrompts();
  const book = deps.memory ?? memory, capture = deps.capture ?? runCommand;
  const explainer = deps.explainer ?? createExplainer({ cacheFile: defaultCacheFile() });
  const repeated = deps.shouldInterrupt ?? shouldInterrupt;
  try {
    if (!args.length || ['--help','-h'].includes(args[0])) {
      ui.warn('Usage:\n  errorbook run [--offline] [--verbose] [--] <command> [args...]\n  errorbook list [--verbose]\n  errorbook sync\n  errorbook dashboard [--no-open]\n  errorbook doctor\n  errorbook scan [dir]\n  errorbook digest [--days N] [--out FILE]\n  errorbook lookup [--json] [error text...]\n  errorbook suggest\n  errorbook mcp'); return args.length ? 0 : 1;
    }
    const verbose = args.includes('--verbose');
    if (args[0] === 'sync') return (await (deps.sync ?? sync)()).ok ? 0 : 1;
    if (args[0] === 'doctor') return await (deps.doctor ?? runDoctor)({ ui });
    // `scan [dir]`: a leading dash is a flag, not a folder name.
    if (args[0] === 'scan') return await (deps.scan ?? runScan)({ ui, dir: args[1]?.startsWith('-') ? null : args[1] ?? null });
    if (args[0] === 'digest') return await (deps.digest ?? runDigest)({ ui, argv: args.slice(1) });
    if (args[0] === 'lookup') return await (deps.lookup ?? runLookup)({ ui, argv: args.slice(1) });
    if (args[0] === 'suggest') return await (deps.suggest ?? runSuggest)({ ui });
    // The MCP server owns stdout for the protocol, so it is handed the streams
    // directly rather than the display.
    if (args[0] === 'mcp') return await (deps.mcp ?? runMcp)({});
    if (args[0] === 'dashboard') {
      const events = book.loadAll();
      const file = (deps.writeDashboard ?? writeDashboard)(events);
      ui.line(`Wrote ${file}`);
      ui.line(`${events.length} notebook ${events.length === 1 ? 'entry' : 'entries'}.`);
      if (!events.length) ui.line('The notebook is empty, so the page will have nothing to show yet.');
      if (!args.includes('--no-open')) (deps.openInBrowser ?? openInBrowser)(file);
      return 0;
    }
    if (args[0] === 'list') {
      const ids = [...new Set(book.loadAll().filter(e => e.type === 'solved').map(e => e.fingerprint))];
      if (!ids.length) ui.line('No saved fixes yet.');
      // No kind: a listing is not a match, so no match heading is claimed.
      for (const id of ids) { const result = book.lookup(id); if (result.fix) { ui.line(`\nFingerprint: ${id}`); ui.fixes([result.fix,...result.alternatives],{verbose}); } } return 0;
    }
    if (args[0] !== 'run') throw new Error(`Unknown command: ${args[0]}`);
    const argv = args.slice(1); let offline = false;
    // Our own flags, in any order, up to the optional `--` that ends them.
    while (argv.length) {
      if (argv[0] === '--offline') { offline = true; argv.shift(); continue; }
      if (argv[0] === '--verbose') { argv.shift(); continue; }
      break;
    }
    if (argv[0] === '--') argv.shift();
    if (!argv.length) throw new Error('errorbook run: no command given');
    // Read before the run: if this command was shown a fix last time and
    // nobody voted, how it exits now is the vote.
    const command = argv.join(' ');
    const pending = (() => { try { return book.readPending?.(command) ?? null; } catch { return null; } })();
    const exitCode = await capture(argv, { onFailure: async report => {
      try {
        // It failed again, so the fix it was given did not work -- but a
        // silent retry is not a rejection either, so the entry is dropped and
        // nothing is recorded.
        try { book.dropPending?.(command); } catch { /* advisory */ }
        const event = contextFromFailure(report);
        ui.line(`\n[errorbook] Command failed with exit code ${report.exitCode} (${report.durationMs}ms)`);
        if (repeated(report.command)) ui.line('[errorbook] This command has failed 3+ times in the last 5 minutes.');
        if (!event) { ui.line('No stderr fingerprint is available. Lookup and AI analysis were skipped.'); return; }
        ui.error(event);
        if (verbose) ui.line(`Language: ${event.loose.lang} - type: ${event.loose.errorType ?? '-'} - file: ${event.file ?? '-'}`);

        // How long the notebook took to answer. This is the number the whole
        // tool exists to make small, so it is printed on the match heading.
        const startedAt = performance.now();
        const result = await book.lookup(event.errorId,event.loose);
        const lookupMs = Math.max(1, Math.round(performance.now() - startedAt));

        let explanation = null, offerSave = true;
        const matched = result.kind !== 'none' && result.fix;
        // Measured, not derived: one line saying the notebook was asked and how
        // it answered. Recorded here and nowhere else -- `lookup`, `mcp` and
        // the rest are read-only by design, and counting a question somebody
        // typed as an encounter with a failing command would inflate the rate.
        // The outcome is the one the user was just shown, so the number can
        // never claim a hit the terminal called a miss.
        book.appendLookup?.(event.errorId, !matched ? 'miss' : result.kind === 'loose' ? 'loose' : 'hit');
        if (matched) {
          const fixes = [result.fix,...result.alternatives];
          // The caveat belongs before the fix, so it is read first.
          if (result.kind === 'loose') ui.line('\nThis is a similar error, not an exact match. Verify that the solution applies.');
          ui.fixes(fixes,{kind:result.kind,lookupMs,verbose});
          // One question per failure. A new fix is only worth asking about when
          // every fix the team already has is known to have failed.
          offerSave = fixes.every(f => f.confidence === 'failed');
          let answered = false; // did the developer say what happened?
          if (prompts.interactive) {
            const selection = fixes.length === 1 ? '1' : await prompts.ask('Select a solution number (Enter to skip): ');
            const chosen = fixes[Number(selection)-1];
            if (chosen) {
              const answer = (await prompts.ask('After trying this fix: worked [y], failed [n], error returned [r], Enter to skip: ')).toLowerCase();
              const type = {y:'confirmed',yes:'confirmed',n:'rejected',no:'rejected',r:'returned'}[answer];
              if (type) {
                answered = true;
                const author = book.me();
                if (type === 'confirmed' && author === chosen.author) ui.line('You cannot confirm your own fix. Another teammate must verify it.');
                else {
                  // A loose match can belong to a DIFFERENT error fingerprint.
                  await book.append({type,fingerprint:chosen.fingerprint,fixId:chosen.fixId,author});
                  const refreshed = await book.lookup(chosen.fingerprint);
                  const saved = [refreshed.fix,...refreshed.alternatives].find(f=>f?.fixId===chosen.fixId);
                  ui.line(`Recorded ${type}.`); if (saved) ui.fixes([saved],{verbose});
                }
              }
            }
          }
          // Nobody said what happened to an exact match, so the next run of
          // this exact command gets to answer instead. Exact only: a loose
          // match's fix belongs to another error, so a passing command says
          // nothing about it. Only the top-ranked fix -- the one the terminal
          // led with -- and never one's own.
          if (result.kind === 'exact' && !answered && prompts.interactive) {
            const author = book.me(), top = fixes[0];
            if (top && top.author !== author && !hasVoted(book, author, top.fixId)) {
              try { book.savePending?.({ command, fingerprint: top.fingerprint, fixId: top.fixId, author }); } catch { /* advisory */ }
            }
          }
        } else {
          ui.line('This error is not in the notebook yet.');
          explanation = await explainer.explain(event,{offline}); ui.explanation(explanation);
        }
        if (offerSave && prompts.interactive && await prompts.yes('Save a new solution you actually applied?')) {
          const fix = await prompts.ask('Actual fix applied (Enter to cancel): ');
          if (fix) {
            const saved = await book.append({type:'solved',fingerprint:event.errorId,loose:event.loose,summary:event.summary,raw:event.displayError,fix,author:book.me()});
            ui.line(verbose ? `Saved fix ${saved.fixId}. Run errorbook sync to share it.` : 'Saved. Run errorbook sync to share it.');
          } else ui.line('Not saved: no fix text supplied.');
        }
      } catch (error) { ui.warn(`[errorbook] Assistance unavailable: ${error.message}`); }
    } });
    if (exitCode === 0) await autoConfirm(book, ui, pending);
    return exitCode;
  } catch (error) { ui.warn(`[errorbook] ${error.message}`); return 1; }
  finally { prompts.close(); }
}
