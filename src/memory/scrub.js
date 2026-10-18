// Removes secrets from text before it's saved. The notebook goes into git,
// and once a password is in git history you can't really take it back.
const RULES = [
  // -----BEGIN PRIVATE KEY----- ... -----END PRIVATE KEY-----
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[private key removed]"],
  // postgres://user:password@host  →  postgres://***:***@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s:/@]+:[^\s@/]+@/gi, "$1***:***@"],
  // Authorization: Bearer abc123
  [/\b(authorization:\s*(?:bearer|basic|token)\s+)[^\s"']+/gi, "$1***"],
  // PASSWORD=..., api_key: ..., DB_SECRET="..."
  [/\b([A-Za-z0-9_]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)[A-Za-z0-9_]*)(\s*[=:]\s*)(["']?)[^\s"',;]+\3/gi, "$1$2$3***$3"],
  // Well-known key formats
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "***"], // OpenAI / Anthropic style keys
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, "***"], // GitHub tokens
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "***"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "***"], // AWS access key IDs
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "***"], // Slack tokens
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "***"], // JWTs
];

export function scrub(text) {
  if (typeof text !== "string") return text;
  return RULES.reduce((t, [pattern, replacement]) => t.replace(pattern, replacement), text);
}