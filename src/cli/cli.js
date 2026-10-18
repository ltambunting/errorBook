import { runCommand, shouldInterrupt } from '../capture/index.js';
import * as memory from '../memory/index.js';
import { sync } from '../sync/index.js';
import { contextFromFailure } from '../explainer/context.js';
import { createExplainer } from '../explainer/explainer.js';
import { defaultCacheFile } from '../explainer/cache.js';
import { createDisplay } from './display.js';
import { createPrompts } from './prompts.js';

export async function runCli(args, deps = {}) {
  const ui = deps.ui ?? createDisplay(), prompts = deps.prompts ?? createPrompts();
  const book = deps.memory ?? memory, capture = deps.capture ?? runCommand;
  const explainer = deps.explainer ?? createExplainer({ cacheFile: defaultCacheFile() });
  const repeated = deps.shouldInterrupt ?? shouldInterrupt;
  try {
    if (!args.length || ['--help','-h'].includes(args[0])) {
      ui.warn('Usage:\n  errorbook run [--offline] [--] <command> [args...]\n  errorbook list\n  errorbook sync'); return args.length ? 0 : 1;
    }
    if (args[0] === 'sync') return (await (deps.sync ?? sync)()).ok ? 0 : 1;
    if (args[0] === 'list') {
      const ids = [...new Set(book.loadAll().filter(e => e.type === 'solved').map(e => e.fingerprint))];
      if (!ids.length) ui.line('No saved fixes yet.');
      // No kind: a listing is not a match, so no "Exact match" heading.
      for (const id of ids) { const result = book.lookup(id); if (result.fix) { ui.line(`\nFingerprint: ${id}`); ui.fixes([result.fix,...result.alternatives]); } } return 0;
    }
    if (args[0] !== 'run') throw new Error(`Unknown command: ${args[0]}`);
    const argv = args.slice(1); let offline = false;
    if (argv[0] === '--offline') { offline = true; argv.shift(); }
    if (argv[0] === '--') argv.shift();
    if (!argv.length) throw new Error('errorbook run: no command given');
    return await capture(argv, { onFailure: async report => {
      try {
        const event = contextFromFailure(report);
        ui.line(`\n[errorbook] Command failed with exit code ${report.exitCode} (${report.durationMs}ms)`);
        if (repeated(report.command)) ui.line('[errorbook] This command has failed 3+ times in the last 5 minutes.');
        if (!event) { ui.line('No stderr fingerprint is available. Lookup and AI analysis were skipped.'); return; }
        ui.error(event);
        ui.line(`Language: ${event.loose.lang} - type: ${event.loose.errorType ?? '-'} - file: ${event.file ?? '-'}`);
        const result = await book.lookup(event.errorId,event.loose);
        let explanation = null;
        if (result.kind !== 'none' && result.fix) {
          const fixes = [result.fix,...result.alternatives]; ui.fixes(fixes,result.kind);
          if (result.kind === 'loose') ui.line('This is a similar error, not an exact match. Verify that the solution applies.');
          if (prompts.interactive) {
            const selection = fixes.length === 1 ? '1' : await prompts.ask('Select a solution number (Enter to skip): ');
            const chosen = fixes[Number(selection)-1];
            if (chosen) {
              const answer = (await prompts.ask('After trying this fix: worked [y], failed [n], error returned [r], Enter to skip: ')).toLowerCase();
              const type = {y:'confirmed',yes:'confirmed',n:'rejected',no:'rejected',r:'returned'}[answer];
              if (type) {
                const author = book.me();
                if (type === 'confirmed' && author === chosen.author) ui.line('You cannot confirm your own fix. Another teammate must verify it.');
                else {
                  // A loose match can belong to a DIFFERENT error fingerprint.
                  await book.append({type,fingerprint:chosen.fingerprint,fixId:chosen.fixId,author});
                  const refreshed = await book.lookup(chosen.fingerprint);
                  const saved = [refreshed.fix,...refreshed.alternatives].find(f=>f?.fixId===chosen.fixId);
                  ui.line(`Recorded ${type}.`); if (saved) ui.fixes([saved],'exact');
                }
              }
            }
          }
        } else {
          ui.line('This error is not in the notebook yet.');
          explanation = await explainer.explain(event,{offline}); ui.explanation(explanation);
        }
        // Also allow a better solution when the notebook already has failed fixes.
        if (prompts.interactive && await prompts.yes('Save a new solution you actually applied?')) {
          const fix = await prompts.ask('Actual fix applied (Enter to cancel): ');
          if (fix) {
            const saved = await book.append({type:'solved',fingerprint:event.errorId,loose:event.loose,summary:event.summary,raw:event.displayError,fix,author:book.me()});
            ui.line(`Saved fix ${saved.fixId}. Team confidence is computed by the notebook.`);
          } else ui.line('Not saved: no fix text supplied.');
        }
      } catch (error) { ui.warn(`[errorbook] Assistance unavailable: ${error.message}`); }
    } });
  } catch (error) { ui.warn(`[errorbook] ${error.message}`); return 1; }
  finally { prompts.close(); }
}
