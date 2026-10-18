// The only file other people import from.
import { loadAll } from "./store.js";
import { groupByError } from "./tally.js";
import { pick } from "./rank.js";

export { append, appendLookup, loadAll, me, makeFixId, LOOKUP_RESULTS } from "./store.js";
export { savePending, readPending, dropPending, isPendingExpired, PENDING_WINDOW_MS } from "./pending.js";
export { scrub } from "../fingerprint/index.js";

// Two loose descriptions match if they're the same kind of error in the same
// language (and the same file, when both know the file).
export function looseMatch(a, b) {
  if (!a || !b) return false;
  if (a.lang !== b.lang || a.errorType !== b.errorType) return false;
  return !a.file || !b.file || a.file === b.file;
}

// "Have we seen this before?" → { kind: "exact" | "loose" | "none", fix, alternatives }
export function lookup(fingerprint, loose = null) {
  const errors = groupByError(loadAll());

  const exact = errors.get(fingerprint);
  if (exact) return { kind: "exact", ...pick(exact.fixes) };

  if (loose) {
    const near = [...errors.values()].filter((e) => looseMatch(loose, e.loose)).flatMap((e) => e.fixes);
    if (near.length) return { kind: "loose", ...pick(near) };
  }

  return { kind: "none", fix: null, alternatives: [] };
}