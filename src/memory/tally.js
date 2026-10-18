// Turns the diary of lines into: error → fixes → counted votes.
// Nothing is counted in the files; all counting happens here, when reading.

export function groupByError(events) {
  const sorted = [...events].sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  const errors = new Map(); // fingerprint → { fingerprint, summary, loose, fixes: Map }

  for (const e of sorted) {
    if (e.type === "solved") {
      if (!errors.has(e.fingerprint)) {
        errors.set(e.fingerprint, { fingerprint: e.fingerprint, summary: e.summary, loose: e.loose, fixes: new Map() });
      }
      const fixes = errors.get(e.fingerprint).fixes;
      const existing = fixes.get(e.fixId);
      if (!existing) {
        fixes.set(e.fixId, {
          fingerprint: e.fingerprint,
          fixId: e.fixId,
          fix: e.fix,
          author: e.author,
          firstSeen: e.ts,
          timeToSolve: e.timeToSolve ?? null,
          ups: new Map(), // person → when
          downs: new Map(), // person → when
          returns: [], // when it came back
        });
      } else if (e.author !== existing.author) {
        // Someone else saved the exact same fix: that's a thumbs up.
        thumbsUp(existing, e);
      }
      continue;
    }

    const fix = errors.get(e.fingerprint)?.fixes.get(e.fixId);
    if (!fix) continue; // a vote for a fix we haven't pulled yet
    if (e.type === "confirmed") thumbsUp(fix, e);
    if (e.type === "rejected") thumbsDown(fix, e);
    if (e.type === "returned") fix.returns.push(e.ts);
  }

  for (const error of errors.values()) error.fixes = [...error.fixes.values()].map(summarise);
  return errors;
}

// One vote per person: their latest vote replaces an earlier one.
// Three downs from three people count as 3; three from one person count as 1.
function thumbsUp(fix, e) {
  if (e.author === fix.author) return; // you can't vote for your own fix
  fix.downs.delete(e.author);
  fix.ups.set(e.author, e.ts);
}

function thumbsDown(fix, e) {
  fix.ups.delete(e.author);
  fix.downs.set(e.author, e.ts);
}

function summarise(fix) {
  const confirmations = fix.ups.size;
  const rejections = fix.downs.size;
  const lastConfirmed = [...fix.ups.values()].sort().pop() ?? null;
  // It "came back" if a returned line is newer than the last thumbs up.
  const returned = fix.returns.some((ts) => ts > (lastConfirmed ?? fix.firstSeen));
  return {
    fingerprint: fix.fingerprint,
    fixId: fix.fixId,
    fix: fix.fix,
    author: fix.author,
    firstSeen: fix.firstSeen,
    confirmations,
    rejections,
    returned,
    confidence: confidence(confirmations, rejections, returned),
  };
}

// The table from the spec.
export function confidence(ups, downs, returned) {
  if (returned || downs >= 2) return "failed";
  if (downs > ups) return "low";
  if (ups === 0 && downs === 0) return "unproven";
  if (downs === 0) return ups >= 2 ? "high" : "medium";
  return ups > downs ? "medium" : "unproven"; // mixed results (not in the spec: agree with the team)
}