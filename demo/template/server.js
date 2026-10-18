// Broken state 3: binds port 3000 and holds it. Start it once in the
// background, then run it again through errorbook to get EADDRINUSE.
import { createServer } from 'node:http';

createServer((_req, res) => res.end('errorbook demo\n')).listen(3000, () => {
  console.log('listening on http://localhost:3000');
});
