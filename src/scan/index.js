// `errorbook scan [dir]`: reads the notebook back and reports any line that
// still looks like it carries a credential. Read-only -- it never rewrites a
// line, because the notebook is append-only and a fix is the author's to edit.
//
// The detector is scrub() from src/fingerprint, the same function that masks a
// line on the way in. There are deliberately no patterns of our own here: a
// second copy of the rules would drift from the one that does the real work,
// and this command exists to find what that one let through (an older line
// saved before a rule existed, or a line hand-edited since).
//
// THE OUTPUT RULE, which every line below obeys: nothing is printed unless it
// came out of scrub(). The original text is never printed -- not in a finding,
// not in a summary, and not in an error, which is why a JSON parse failure
// here is silent rather than reported (V8 puts a slice of the offending line
// into its message).
import nodeFs from 'node:fs';
import path from 'node:path';
import { scrub } from '../fingerprint/index.js';
import { createDisplay } from '../cli/display.js';
import { dataDir } from '../paths.js';

// One finding is one line of output, so the masked text is cut to something a
// terminal can show. A prefix of masked text is still masked text.
const MAX_MASKED = 160;

// ASCII only. This is not a detection rule -- scrub() does all of that -- it is
// the printer refusing to emit anything but printable ASCII, so a notebook line
// cannot smuggle an escape sequence or a newline into the report and fake a
// finding's file name.
const ascii = (text) => String(text).replace(/[^\x20-\x7e]/g, '?');

const clip = (text) => (text.length > MAX_MASKED ? `${text.slice(0, MAX_MASKED - 3)}...` : text);

const show = (text) => clip(ascii(text));

// Every string in the event, by path: "fix", "loose.file", "argv[0]". Numbers
// and booleans are skipped -- scrub() works on text, and a credential that
// survived JSON encoding is a string.
export function stringFields(value, prefix = '') {
  const out = [];
  if (typeof value === 'string') {
    if (prefix) out.push([prefix, value]);
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => out.push(...stringFields(item, `${prefix}[${index}]`)));
    return out;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      out.push(...stringFields(item, prefix ? `${prefix}.${key}` : key));
    }
  }
  return out;
}

// What scrub() masks in one field, or null if it masks nothing there.
//
// Asked twice, because half of scrub()'s rules key off the name next to the
// value: "hunter2" on its own is just a word, while `"password":"hunter2"` is a
// credential. The value is tried alone first so the narrower answer wins, then
// the name/value pair the way it appears in the file.
export function maskField(field, value) {
  const alone = JSON.stringify(value);
  const maskedAlone = scrub(alone);
  if (maskedAlone !== alone) return maskedAlone;
  const pair = `${JSON.stringify(field)}:${alone}`;
  const maskedPair = scrub(pair);
  return maskedPair === pair ? null : maskedPair;
}

// The findings on one raw line, as { field, masked }.
//
// A line counts as a finding when scrub() changes it, which is tested on the
// raw text first -- so a corrupt line that cannot be parsed is still scanned,
// it just cannot have a field named for it. Parsing is only how a finding gets
// a field name; when it fails or the line is not an object, the finding is
// reported against "-" with the whole masked line.
export function scanLine(raw) {
  const findings = [];
  const line = String(raw).replace(/^﻿/, '').trim(); // the loader's own conventions
  if (!line) return findings;
  const maskedLine = scrub(line);

  let event = null;
  try {
    event = JSON.parse(line);
  } catch {
    // Silent on purpose: the parse error's message would quote the line.
  }
  if (event && typeof event === 'object' && !Array.isArray(event)) {
    for (const [field, value] of stringFields(event)) {
      const masked = maskField(field, value);
      if (masked) findings.push({ field, masked });
    }
  }
  // Nothing attributed, but the line as a whole still changed: the credential
  // straddles the JSON itself, or sits in a line that would not parse. Report
  // it rather than lose it.
  if (!findings.length && maskedLine !== line) findings.push({ field: '-', masked: maskedLine });
  return findings;
}

// Every .jsonl in one folder. `missing` is kept apart from `errors` because a
// notebook folder that does not exist yet is a fresh checkout, while a folder
// that exists and cannot be read is a result we must not call clean.
export function scanDir({ fs = nodeFs, dir }) {
  const findings = [];
  const errors = [];
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return { findings, errors, missing: true, files: 0, lines: 0 };
    return { findings, errors: [`cannot read ${dir} (${error.code ?? 'unknown'})`], missing: false, files: 0, lines: 0 };
  }

  const files = names.filter((name) => name.endsWith('.jsonl')).sort();
  let lines = 0;
  for (const name of files) {
    let text;
    try {
      text = fs.readFileSync(path.join(dir, name), 'utf8');
    } catch (error) {
      errors.push(`cannot read ${name} (${error.code ?? 'unknown'})`);
      continue;
    }
    text.split(/\r?\n/).forEach((raw, index) => {
      if (raw.trim()) lines++;
      for (const finding of scanLine(raw)) findings.push({ file: name, line: index + 1, ...finding });
    });
  }
  return { findings, errors, missing: false, files: files.length, lines };
}

// --- the command -----------------------------------------------------------

// Findings and anything that went wrong go to stderr, so `errorbook scan` can
// be a gate in a hook or a CI step: stdout is "clean" or it is empty.
export function runScan(deps = {}) {
  const ui = deps.ui ?? createDisplay();
  // An explicit folder is held to a stricter standard than the default one: a
  // folder someone named and that is not there is a mistake worth an exit 1,
  // while the notebook simply not existing yet is not.
  const requested = deps.dir ?? null;
  const dir = requested ?? deps.notebookDir ?? dataDir();
  const result = scanDir({ fs: deps.fs ?? nodeFs, dir });

  if (result.missing && requested) {
    ui.warn(`errorbook scan: ${show(dir)} does not exist`);
    return 1;
  }

  for (const finding of result.findings) {
    ui.warn(`${show(finding.file)}:${finding.line} ${show(finding.field)} ${show(finding.masked)}`);
  }
  for (const error of result.errors) ui.warn(`errorbook scan: ${show(error)}`);

  if (result.findings.length) {
    const n = result.findings.length;
    ui.warn(`\n${n} ${n === 1 ? 'finding' : 'findings'} in ${result.files} ${result.files === 1 ? 'file' : 'files'}. Shown masked; the notebook still holds the original text.`);
    ui.warn('Edit the listed lines out of the notebook, then run errorbook sync.');
    return 1;
  }
  // Not clean, just unread: never the word "clean" over a folder we failed on.
  if (result.errors.length) return 1;

  ui.line('clean');
  return 0;
}
