// The notebook's paths now come from the shared resolver, so capture, memory
// and the explanation cache cannot drift apart. Re-exported here because this
// is the path other memory files import.
export { repoRoot, dataDir, localDir } from "../paths.js";
