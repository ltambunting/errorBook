// `errorbook dashboard`: writes the dashboard with the team's notebook already
// embedded, and opens it.
//
// A file:// page is not allowed to fetch its sibling files, so a dashboard that
// reads .errorbook/*.jsonl by itself cannot work without a server. Instead the
// data is inlined into a copy of dashboard/index.html, which then opens from
// disk with no server at all.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { localDir, dataDir } from '../paths.js';

const TEMPLATE = fileURLToPath(new URL('../../dashboard/index.html', import.meta.url));
const MARKER = /(<script type="application\/json" id="errorbook-data">)([\s\S]*?)(<\/script>)/;

// `</script>` inside the JSON would end the block early, and a lone U+2028 is a
// newline to a JS parser. Escaping `<` covers the first and is cheap.
export function embed(json) {
  // Every escape here is assembled from a character code, because a literal
  // escape sequence is easily collapsed by one level by an editor or a patch
  // tool, and a literal U+2028 would be a line terminator to the parser.
  const esc = String.fromCharCode(92) + "u";
  const separators = new RegExp("[" + esc + "2028" + esc + "2029]", "g");
  return JSON.stringify(json)
    .replace(/</g, esc + "003c")
    .replace(separators, (c) => esc + c.charCodeAt(0).toString(16));
}

// Puts the payload into the template's data block. Everything else is untouched,
// so the page stays a single self-contained file.
export function buildHtml(template, payload) {
  if (!MARKER.test(template)) throw new Error('dashboard template has no errorbook-data block');
  return template.replace(MARKER, (_all, open, _old, close) => open + embed(payload) + close);
}

export function dashboardPath() {
  return join(localDir(), 'dashboard.html');
}

// Hands the file to whatever the desktop uses. Never fatal: the path is printed
// either way, so a headless machine just gets the path.
export function openInBrowser(file, platform = process.platform) {
  try {
    const [cmd, args] =
      platform === 'win32' ? ['cmd', ['/c', 'start', '', file]]
      : platform === 'darwin' ? ['open', [file]]
      : ['xdg-open', [file]];
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export function writeDashboard(events, { template = TEMPLATE, out = dashboardPath() } = {}) {
  const payload = {
    events,
    notebook: dataDir(),
    generatedAt: new Date().toISOString(),
  };
  const html = buildHtml(readFileSync(template, 'utf8'), payload);
  mkdirSync(dirname(out), { recursive: true });
  // Keeps the generated page out of git even if the repo's .gitignore drifts.
  writeFileSync(join(dirname(out), '.gitignore'), '*\n');
  writeFileSync(out, html);
  return out;
}
