// Reads every .txt in samples/ and checks that the same error captured on
// different machines fingerprints identically, while different errors do not
// collide.  Files are grouped by the filename prefix before the last `-`, so
// npm-missing-script-ankit.txt and npm-missing-script-louis.txt pair up.
//   node test/fingerprint.test.js
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprint, normalize, scrub } from '../src/fingerprint/index.js';

const SAMPLES = join(dirname(fileURLToPath(import.meta.url)), '..', 'samples');

let failures = 0;
const expect = (label, actual, wanted) => {
  const ok = actual === wanted;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${actual}${ok ? '' : ` (expected ${wanted})`}`);
};

const files = readdirSync(SAMPLES)
  .filter((name) => name.endsWith('.txt'))
  .sort();

if (files.length === 0) {
  console.error(`no .txt samples in ${SAMPLES}`);
  process.exit(1);
}

// prefix = everything before the last `-` in the basename.
const groups = new Map();
for (const name of files) {
  const stem = name.replace(/\.txt$/, '');
  const prefix = stem.slice(0, stem.lastIndexOf('-'));
  const result = fingerprint(readFileSync(join(SAMPLES, name), 'utf8'));
  if (!groups.has(prefix)) groups.set(prefix, []);
  groups.get(prefix).push({ name, ...result });
}

console.log('--- samples ---');
for (const [prefix, entries] of groups) {
  console.log(`\n[${prefix}]`);
  for (const entry of entries) {
    console.log(`  ${entry.name}`);
    console.log(`    id:      ${entry.id}`);
    console.log(`    loose:   ${JSON.stringify(entry.loose)}`);
    console.log(`    summary: ${entry.summary}`);
  }
}

console.log('\n--- same error, different machines ---');
for (const [prefix, entries] of groups) {
  if (entries.length < 2) {
    console.log(`skip ${prefix}: only one sample`);
    continue;
  }
  const [first, ...rest] = entries;
  for (const entry of rest) {
    expect(`${prefix}: ${entry.name} matches ${first.name}`, entry.id, first.id);
  }
}

console.log('\n--- different errors do not collide ---');
const prefixes = [...groups.keys()];
if (prefixes.length < 2) console.log('skip: need at least two sample groups');
for (let i = 0; i < prefixes.length; i++) {
  for (let j = i + 1; j < prefixes.length; j++) {
    const a = groups.get(prefixes[i])[0];
    const b = groups.get(prefixes[j])[0];
    expect(`${prefixes[i]} vs ${prefixes[j]}`, a.id === b.id, false);
  }
}

console.log('\n--- shape ---');
for (const [, entries] of groups) {
  for (const entry of entries) {
    expect(`${entry.name}: id is 6 hex chars`, /^[0-9a-f]{6}$/.test(entry.id), true);
    expect(`${entry.name}: summary within 120 chars`, entry.summary.length <= 120, true);
    const nulls = Object.values(entry.loose).filter((v) => v !== null && typeof v !== 'string');
    expect(`${entry.name}: loose parts are strings or null`, nulls.length, 0);
  }
}

console.log('\n--- normalize is stable ---');
const sample = readFileSync(join(SAMPLES, files[0]), 'utf8');
expect('idempotent', normalize(normalize(sample)), normalize(sample));
expect('no blank lines', /^\s*$/m.test(normalize(sample)), false);
expect('empty input', normalize(''), '');
expect('empty input fingerprints to null id', fingerprint('').id, null);

console.log('\n--- scrub ---');
const secrets = [
  ['https://ankit:hunter2@github.com/acme/app.git', 'hunter2'],
  ['GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123', 'ghp_'],
  ['Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', 'eyJ'],
  ['{ "password": "correct horse battery" }', 'correct'],
  ['OPENAI_API_KEY=sk-proj-abcdefghijklmnop', 'sk-'],
  ['aws_access_key_id = AKIAIOSFODNN7EXAMPLE', 'AKIA'],
  ['--api-key 9f8e7d6c5b4a39281706f5e4d3c2b1a0', '9f8e7d'],
  ['digest 5d41402abc4b2a76b9719d911017c592e1f2a3b4', '5d41402a'],
  ['{ "password": "correct horse battery staple" }', 'horse'],
  ["db_password: 'p@ss w0rd', host: 'localhost'", 'w0rd'],
  ['npm error 404  https://ankit:tok3n@registry.npmjs.org/private-pkg', 'tok3n'],
];
for (const [input, leak] of secrets) {
  const masked = scrub(input);
  expect(`masked: ${input.slice(0, 44)}`, masked.includes(leak), false);
  expect(`  -> ${masked.slice(0, 64)}`, masked.includes('[redacted]'), true);
}
expect('scrub keeps ordinary text', scrub('npm error Missing script: "build"'), 'npm error Missing script: "build"');
expect('scrub empty input', scrub(''), '');

// Git identity is the headline demo error, so author lines must stay readable:
// `auth` must not be treated as a secret key, only `authorization`.
const survives = [
  'Author: ankit <a@b.com>',
  'Author: ankit <ankit.acoolguy@gmail.com>',
  "fatal: unable to auto-detect email address (got 'ankit@DESKTOP-7F2A.(none)')",
  '  git config --global user.name "Ankit Aggarwal"',
  'hint: Author identity unknown',
];
for (const line of survives) {
  expect(`survives scrub: ${line.trim().slice(0, 52)}`, scrub(line), line);
}
// But a real authorization header is still masked.
expect(
  'authorization header still masked',
  scrub('Authorization: Bearer abcdefghijklmnop').includes('abcdefghijklmnop'),
  false,
);
expect('auth_token still masked', scrub('AUTH_TOKEN=abcdefghijklmnop').includes('abcdefgh'), false);

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exitCode = failures === 0 ? 0 : 1;
