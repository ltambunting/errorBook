import { fingerprint, normalize, scrub } from '../fingerprint/index.js';
// This is an adapter namespace for the reviewed upstream fingerprint algorithm.
// It does not change the upstream hash or add a prefix to its six-character ID.
export const FINGERPRINT_VERSION = 'errorBook2-16126e2';
export function contextFromFailure(report) {
  const safeError = scrub(report.stderr || '');
  const result = fingerprint(safeError);
  if (!result.id) return null;
  return {
    errorId: result.id,
    normalizationVersion: FINGERPRINT_VERSION,
    normalizedError: normalize(safeError),
    displayError: safeError,
    summary: result.summary,
    loose: result.loose,
    file: result.loose.file,
    exitCode: report.exitCode,
    durationMs: report.durationMs,
  };
}
