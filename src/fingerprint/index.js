// Raw stderr text in, stable short id out.
//
// The same error on two machines must normalize to the same text: paths,
// timestamps, pids, ports and numbers all carry machine-specific noise, so they
// are reduced to placeholders before hashing.
import { createHash } from 'node:crypto';

const ID_LENGTH = 6;
const SUMMARY_MAX = 120;
const REDACTED = '[redacted]';

// --- scrub ----------------------------------------------------------------

// proto://user:pass@host
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;

// Authorization: Bearer <token>, and `token <value>` forms.
const AUTH_SCHEME = /\b(bearer|basic|token)\s+([a-z0-9._~+/=-]{8,})/gi;

// Anchored to `authorization`, never a bare `auth`: git prints "Author:" lines
// and those have to stay readable.
const SECRET_WORD = '(?:secret|token|password|passwd|api_?key|authorization|credential)';

const SECRET_KEY = `[\\w.-]*${SECRET_WORD}s?[\\w.-]*["']?\\s*[:=]+\\s*`;

// "key": "value with spaces" -- the whole quoted run goes, not just its first
// word.
const SECRET_ASSIGNMENT_QUOTED = new RegExp(`(${SECRET_KEY})(["'])(?:\\\\.|(?!\\2)[^\\\\])*\\2`, 'gi');

// key=value, key: value. The value must not start with a quote, so a value
// already masked by the rule above is left alone.
const SECRET_ASSIGNMENT_BARE = new RegExp(
  `(${SECRET_KEY})(?:(?:bearer|basic|token)\\s+)?(?!["'])[^\\s"',;&)]+`,
  'gi',
);

// --token <value>, --api-key <value>
const SECRET_FLAG = new RegExp(`(--[\\w-]*${SECRET_WORD}[\\w-]*)(\\s+)(?!-)[^\\s]+`, 'gi');

const KNOWN_PREFIXES = [
  /\bsk-[a-z0-9_-]{8,}/gi, // OpenAI-style
  /\bgh[pousr]_[a-z0-9]{16,}/gi, // GitHub
  /\bAKIA[0-9A-Z]{8,}/g, // AWS access key id
  /\bxox[baprs]-[a-z0-9-]{8,}/gi, // Slack
  /\beyJ[a-z0-9_=-]{8,}(?:\.[a-z0-9_=-]+){0,2}/gi, // JWT
];

// Long opaque runs: hex digests, base64 blobs.
const LONG_HEX = /\b[0-9a-f]{32,}\b/gi;
const LONG_BASE64 = /\b[A-Za-z0-9+/]{32,}={0,2}\b/g;

/**
 * Mask credentials. Run this before anything is stored or sent anywhere.
 * @param {string} text
 * @returns {string}
 */
export function scrub(text) {
  if (typeof text !== 'string' || text === '') return '';

  let out = text;
  out = out.replace(URL_USERINFO, `$1${REDACTED}@`);
  for (const re of KNOWN_PREFIXES) out = out.replace(re, REDACTED);
  out = out.replace(AUTH_SCHEME, `$1 ${REDACTED}`);
  // Keep the key visible, replace the value (and re-close its quote).
  out = out.replace(SECRET_ASSIGNMENT_QUOTED, `$1$2${REDACTED}$2`);
  out = out.replace(SECRET_ASSIGNMENT_BARE, `$1${REDACTED}`);
  out = out.replace(SECRET_FLAG, `$1$2${REDACTED}`);
  out = out.replace(LONG_HEX, REDACTED);
  out = out.replace(LONG_BASE64, REDACTED);
  return out;
}

// --- normalize ------------------------------------------------------------

// Non-file URLs and node: builtin specifiers are already machine-independent,
// so they are parked while paths are collapsed and restored afterwards.
const URL_RE = /\b(?!file:)[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)\]]+/gi;
const NODE_SPECIFIER = /\bnode:[a-z][\w/.-]*/gi;

// Windows paths may contain spaces in directory names (C:\Program Files\...),
// so only the final segment is required to be space-free.
const WIN_PATH = /(?:file:\/{2,3})?[a-zA-Z]:[\\/](?:[^\\/:*?"<>|\n]*[\\/])*[^\s\\/:*?"<>|\n]*/g;
const POSIX_PATH = /(?:file:\/\/)?\/(?:[^\s/:*?"<>|\n]+\/)+[^\s/:*?"<>|\n]*/g;

const TEMP_MARKERS = [/\/appdata\/local\/temp\//, /\/windows\/temp\//, /^\/tmp\//, /\/var\/folders\//];
const HOME_MARKERS = [/^[a-z]:\/users\/[^/]+\//, /^\/users\/[^/]+\//, /^\/home\/[^/]+\//, /^\/root\//];

const ISO_TIMESTAMP = /\d{4}-\d{2}-\d{2}[t_ ]\d{2}[:_]\d{2}[:_]\d{2}(?:[.,_]\d+)?z?(?:[+-]\d{2}:?\d{2})?/gi;
const LINE_COL = /:\d+(?::\d+)?\b/g;
// Runtime versions (node.js v22.17.0) before the number rules get at them, so
// version drift between machines does not split an id.
const VERSION = /\bv\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?\b/gi;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const BIG_INT = /\b\d{3,}\b/g;
// errno values are platform-specific (ENOENT is -4058 on Windows, -2 on
// POSIX), so the number is dropped regardless of how many digits it has.
const ERRNO = /\berrno:?\s*=?\s*-?(?:<N>|\d+)/gi;
// Hex runs must contain a letter; all-digit runs are handled as numbers.
const HEX_RUN = /\b(?=[0-9a-f]{8,}\b)[0-9a-f]*[a-f][0-9a-f]*\b/gi;
const PORT = /(:{1,3})(?:<N>|\d{1,5})\b/g;
const PID = /\bpid\s*[:=]?\s*(?:<N>|\d+)/gi;

function lastSegment(path) {
  const segments = path.split('/').filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : '';
}

// Home paths keep a `~` marker, temp paths a `<TMP>` marker, and everything
// else is reduced to its basename -- enough to tell the error apart, with no
// trace of whose machine it came from.
function collapsePath(match) {
  const unix = match.replace(/^file:\/{2,3}/i, '').replace(/\\/g, '/');
  const lower = unix.toLowerCase();

  for (const marker of TEMP_MARKERS) {
    const hit = lower.match(marker);
    if (!hit) continue;
    const rest = unix.slice(hit.index + hit[0].length);
    const base = lastSegment(rest);
    return base ? `<TMP>/${base}` : '<TMP>';
  }

  for (const marker of HOME_MARKERS) {
    const hit = lower.match(marker);
    if (!hit) continue;
    const rest = unix.slice(hit[0].length);
    const base = lastSegment(rest);
    return base ? `~/${base}` : '~';
  }

  return lastSegment(unix) || match;
}

/**
 * Reduce stderr to its machine-independent shape.
 * @param {string} stderr
 * @returns {string}
 */
export function normalize(stderr) {
  if (typeof stderr !== 'string' || stderr === '') return '';

  // Park URLs and node: specifiers so path collapsing cannot chew through them
  // (node:internal/modules/esm/loader is a module id, not a file on disk).
  const parked = [];
  const park = (match) => {
    parked.push(match);
    return `\u0000P${parked.length - 1}\u0000`;
  };
  let out = stderr.replace(URL_RE, park).replace(NODE_SPECIFIER, park);

  // Paths first: home -> ~, temp -> <TMP>, anything else absolute -> basename.
  out = out.replace(WIN_PATH, collapsePath).replace(POSIX_PATH, collapsePath);

  out = out.replace(ISO_TIMESTAMP, '<TS>');
  out = out.replace(LINE_COL, ':<N>');
  out = out.replace(VERSION, 'v<VER>');
  // UUIDs before plain integers, so their digit groups stay intact.
  out = out.replace(UUID, '<HEX>');
  out = out.replace(BIG_INT, '<N>');
  out = out.replace(ERRNO, 'errno: <N>');
  out = out.replace(HEX_RUN, '<HEX>');
  out = out.replace(PORT, '$1<PORT>');
  out = out.replace(PID, 'pid <PID>');

  out = out.replace(/\u0000P(\d+)\u0000/g, (_m, i) => parked[Number(i)]);
  out = out.toLowerCase();

  return out
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line !== '')
    .join('\n');
}

// --- loose match ----------------------------------------------------------

const JS_ERROR = /\b(TypeError|ReferenceError|SyntaxError|RangeError|EvalError|URIError|AssertionError)\b/;
const NODE_CODE = /\b(ERR_[A-Z0-9_]+)\b/;
const ERRNO_CODE = /\b(E[A-Z]{3,})\b/;
const NPM_CODE = /npm (?:error|ERR!) code ([^\s]+)/;
const GIT_FATAL = /^(?:fatal|error): /m;

const NPM_MARKER = /^npm (?:error|ERR!|WARN)/m;
const GIT_MARKER = /\b(?:git|hint:|\.git\b)/i;
const NODE_MARKER = /\bnode:[a-z]|node\.js v|\bnode_modules\b|^\s+at .+\(.*:\d+:\d+\)/m;

const FILE_LIKE = String.raw`[\w@.+-]+\.(?:js|mjs|cjs|jsx|ts|tsx|json|node|py|rb|go|rs|java|kt|c|cc|cpp|h|hpp|cs|php|css|scss|html|vue|svelte|ya?ml|toml|lock|md|sh|bat|ps1|txt|log)(?![\w-])`;
// Ordered by how well each position identifies the file the error is about.
const FILE_PATTERNS = [
  new RegExp(String.raw`imported from ([^\s'"\`\n]*${FILE_LIKE})`),
  new RegExp(String.raw`\bat [^\n(]*\(([^)\n]*${FILE_LIKE})(?::\d+)*\)`),
  new RegExp(String.raw`\b(?:open|ENOENT[^\n]*?)['"\`]([^'"\`\n]*${FILE_LIKE})['"\`]`),
  // A bare module specifier is a package name, not a file, so it only counts
  // when it looks like a path.
  new RegExp(String.raw`[Cc]annot find (?:module|package) ['"\`]([^'"\`\n]*${FILE_LIKE})['"\`]`),
  new RegExp(String.raw`(^|[\s'"\`(\[])((?:[\w.~@+-]+[\\/])*${FILE_LIKE})`, 'm'),
];

function basename(value) {
  const segments = value.replace(/\\/g, '/').split('/').filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : null;
}

function detectLang(raw) {
  if (NPM_MARKER.test(raw)) return 'npm';
  if (GIT_FATAL.test(raw) && GIT_MARKER.test(raw)) return 'git';
  if (NODE_MARKER.test(raw)) return 'node';
  if (GIT_MARKER.test(raw)) return 'git';
  return 'unknown';
}

function detectErrorType(raw, lang) {
  const npm = raw.match(NPM_CODE);
  if (npm) return npm[1];
  const node = raw.match(NODE_CODE);
  if (node) return node[1];
  const js = raw.match(JS_ERROR);
  if (js) return js[1];
  const errno = raw.match(ERRNO_CODE);
  if (errno) return errno[1];
  if (lang === 'git' && GIT_FATAL.test(raw)) return 'fatal';
  return null;
}

function detectFile(raw) {
  for (const pattern of FILE_PATTERNS) {
    const hit = raw.match(pattern);
    if (!hit) continue;
    const captured = hit[hit.length - 1];
    const base = basename(captured);
    // npm's own debug log is noise: it names the run, not the error.
    if (!base || /-debug-\d+\.log$/.test(base)) continue;
    return base;
  }
  return null;
}

// --- fingerprint ----------------------------------------------------------

/**
 * @param {string} stderr
 * @returns {{ id: string|null, loose: { lang: string, errorType: string|null, file: string|null }, summary: string|null }}
 */
export function fingerprint(stderr) {
  const raw = typeof stderr === 'string' ? stderr : '';
  const normalized = normalize(raw);

  if (normalized === '') {
    return { id: null, loose: { lang: 'unknown', errorType: null, file: null }, summary: null };
  }

  const lang = detectLang(raw);
  const summary = normalized.split('\n')[0].slice(0, SUMMARY_MAX);

  return {
    id: createHash('sha256').update(normalized).digest('hex').slice(0, ID_LENGTH),
    loose: {
      lang,
      errorType: detectErrorType(raw, lang),
      file: detectFile(raw),
    },
    summary: summary === '' ? null : summary,
  };
}
