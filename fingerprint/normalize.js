export function normalizeError(rawError) {
    if (typeof rawError !== "string") {
      throw new TypeError("rawError must be a string");
    }
  
    let cleaned = rawError.toLowerCase();
  
    // Remove ANSI terminal color codes.
    cleaned = cleaned.replace(/\u001b\[[0-9;]*m/g, "");
  
    // Normalize Windows npm debug-log paths.
    // Usernames and timestamps in these paths are machine-specific noise.
    cleaned = cleaned.replace(
      /[a-z]:\\users\\[^\\\r\n]+\\appdata\\local\\npm-cache\\_logs\\[^\s"'<>]+/gi,
      "<npm-debug-log>"
    );
  
    // Normalize Unix npm debug-log paths.
    cleaned = cleaned.replace(
      /\/users\/[^/\s]+\/\.npm\/_logs\/[^\s"'<>]+/g,
      "<npm-debug-log>"
    );
  
    // Normalize npm's reported file path while preserving the filename.
    // Example: C:\Users\louis\errorBook\package.json -> <path>/package.json
    cleaned = cleaned.replace(
      /(\bnpm error path\s+)([^\r\n]+)/gi,
      (_, prefix, path) => {
        const filename = path.trim().split(/[\\/]/).pop();
        return `${prefix}<path>/${filename}`;
      }
    );
  
    // Normalize absolute paths in stack-trace locations.
    // Preserve the function name and closing parenthesis.
    cleaned = cleaned.replace(
      /(\bat\s+[^(\r\n]*\()((?:[a-z]:\\|\/)[^()\r\n]*?):\d+(?::\d+)?(\))/gi,
      "$1<path>$3"
    );
  
    // Normalize remaining line and column numbers in common stack formats.
    cleaned = cleaned.replace(/:\d+:\d+(?=[)\s]|$)/g, ":<line>:<column>");
    cleaned = cleaned.replace(/:\d+(?=[)\s]|$)/g, ":<line>");
  
    // Normalize line endings and whitespace.
    cleaned = cleaned.replace(/\r\n?/g, "\n");
    cleaned = cleaned.replace(/[ \t]+/g, " ");
    cleaned = cleaned.replace(/\n{2,}/g, "\n");
    cleaned = cleaned.trim();
  
    return cleaned;
  }