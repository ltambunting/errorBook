const ORDER = { high: 0, medium: 1, unproven: 2, low: 3, failed: 4 };

// Best fix first: confidence → thumbs up minus thumbs down → newest.
// Bad fixes are never removed, just put last: "Louis tried restarting and it
// didn't help" still saves the next person a dead end.
export function pick(fixes) {
  const sorted = [...fixes].sort(
    (a, b) =>
      ORDER[a.confidence] - ORDER[b.confidence] ||
      (b.confirmations - b.rejections) - (a.confirmations - a.rejections) ||
      String(b.firstSeen).localeCompare(String(a.firstSeen)),
  );
  return { fix: sorted[0] ?? null, alternatives: sorted.slice(1) };
}