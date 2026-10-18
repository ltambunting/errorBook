// Broken state 2: express is imported but never installed, so Node fails with
// ERR_MODULE_NOT_FOUND. The filename matters -- the fingerprint keeps the file
// basename, and the notebook's entry for this error was recorded as app.mjs.
import express from 'express';

const app = express();
app.get('/', (_req, res) => res.send('ok'));
app.listen(3000);
