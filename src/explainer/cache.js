import { readFile,writeFile,rename,mkdir,open,unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { localDir } from '../paths.js';

// Two caches, read in this order:
//
//  1. the local one, in the same .errorbook/local that holds capture's retry
//     counter. Written whenever a live answer comes back, gitignored, keyed on
//     the exact normalised text so it can never answer a different error.
//
//  2. the seed, committed to the repo. Hand-checked explanations for the errors
//     the demo relies on, so the demo works with no key and no network. Keyed on
//     the fingerprint alone, because it has to survive being written on one
//     machine and read on another, where the normalised text can still differ by
//     a home directory or a temp path. The fingerprint is the error's identity;
//     that is the whole point of it.
//
// Only the local cache is ever written. The seed is read-only at runtime and is
// regenerated deliberately, by scripts/seed-explanations.mjs.
export function defaultCacheFile() {
  return join(localDir(),'explanation-cache.json');
}
export function defaultSeedFile() {
  return fileURLToPath(new URL('./seed-cache.json', import.meta.url));
}

export const cacheKey=event=>createHash('sha256').update(JSON.stringify([event.normalizationVersion,event.errorId,event.normalizedError,'v1'])).digest('hex');

const shaped = (data) =>
  data?.schemaVersion === 1 && data.entries && typeof data.entries === 'object' && !Array.isArray(data.entries);

export function createCache(file, seedFile = defaultSeedFile()) {
  async function load(path) {
    try {
      const data = JSON.parse(await readFile(path, 'utf8'));
      return shaped(data) ? data : { schemaVersion: 1, entries: {} };
    } catch {
      return { schemaVersion: 1, entries: {} };
    }
  }
  const read = () => load(file);

  return {
    // Returns { value, from } so the caller can tell a machine-local answer from
    // a shipped one, or null when neither cache has it.
    async get(event) {
      const local = (await read()).entries[cacheKey(event)];
      if (local) return { value: local, from: 'local' };
      if (!seedFile) return null;
      const seeded = (await load(seedFile)).entries[event.errorId];
      return seeded ? { value: seeded, from: 'seed' } : null;
    },
    async put(event, value) {
      await mkdir(dirname(file), { recursive: true });
      // Keeps machine-local state out of git even if the repo's .gitignore drifts.
      await writeFile(join(dirname(file), '.gitignore'), '*\n');
      let lock;
      try { lock = await open(file + '.lock', 'wx'); } catch { return false; }
      try {
        const data = await read();
        data.entries[cacheKey(event)] = value;
        await writeFile(file + '.tmp', JSON.stringify(data, null, 2) + '\n');
        await rename(file + '.tmp', file);
        return true;
      } finally {
        await lock.close();
        await unlink(file + '.lock');
      }
    },
  };
}
