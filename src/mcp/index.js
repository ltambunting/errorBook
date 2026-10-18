// `errorbook mcp`: the team notebook as an MCP server over stdio, so a coding
// agent can ask "has anyone here hit this before?" before it starts guessing.
//
// Read-only by construction. The one tool calls answer() from src/lookup, which
// is the same path `errorbook lookup` takes -- scrub, fingerprint, then the
// notebook's own lookup -- so there is no matching logic here and an agent
// cannot write to the notebook, reach the explainer, or touch the disk at all.
//
// The transport is newline-delimited JSON-RPC 2.0, written by hand: one message
// per line, no framing headers, no dependencies. The hard rule of a stdio
// server is that stdout carries nothing but protocol -- a stray console.log
// there corrupts the stream and the client disconnects -- so every log in this
// file goes to stderr.
import { answer } from '../lookup/index.js';
import { displayName } from '../cli/display.js';
import * as memory from '../memory/index.js';

const NAME = 'errorbook';
const VERSION = '0.1.0';
// The version this server is written against. A client that asks for another
// one is echoed its own, which is what the handshake expects.
const PROTOCOL_VERSION = '2024-11-05';

// An error message that does not fit in 64KB is a log file, not an error. The
// head is kept, because that is where the error is.
const MAX_ERROR_TEXT = 64 * 1024;
// A line longer than this is not a message we are going to be able to use, and
// buffering it unbounded is how a server gets killed by the OS instead.
const MAX_LINE = 1024 * 1024;

const TOOL = {
  name: 'errorbook_lookup',
  description:
    "Look up an error message in this team's errorbook notebook and return the fix a teammate "
    + 'recorded for it, with who fixed it, how long ago, and how many people have confirmed it. '
    + 'Read-only: it never writes to the notebook. Use it before debugging an error from scratch.',
  inputSchema: {
    type: 'object',
    properties: {
      error_text: {
        type: 'string',
        description: 'The error output to look up: a stack trace, a failing command\'s stderr, or the error line itself.',
      },
    },
    required: ['error_text'],
    additionalProperties: false,
  },
};

// Anything echoed to the client is printable ASCII on one line. The notebook is
// written by people pasting from terminals, and a control character inside a
// JSON string is both a protocol hazard and noise in an agent's context.
const ascii = (text) => String(text ?? '').replace(/[^\x20-\x7e]/g, ' ').replace(/[ ]{2,}/g, ' ').trim();

const capitalise = (word) => (word ? word[0].toUpperCase() + word.slice(1) : word);

// The first line of the answer, for a reader rather than a parser: an agent
// acts on this sentence, and the JSON under it is there to be quoted exactly.
export function sentence(found, { truncated = false } = {}) {
  const note = truncated ? ' (the error text was truncated to 64KB)' : '';
  if (!found || !found.found) return `No known fix in the team notebook.${note}`;

  const fix = found.json.fix;
  const who = capitalise(displayName(fix.author));
  const when = fix.age ? ` ${fix.age}` : '';
  const parts = [`${who} fixed this${when}`];
  parts.push(fix.confirmations === 1
    ? ', confirmed by 1 teammate.'
    : fix.confirmations > 1
      ? `, confirmed by ${fix.confirmations} teammates.`
      : ', not yet confirmed by anyone else.');
  let text = parts.join('');
  if (found.kind === 'loose') {
    text = `Similar error, not an exact match -- verify it applies. ${text}`;
  }
  if (fix.returned) text += ' Note: the error has since come back after this fix.';
  const others = found.json.alternatives.length;
  if (others) text += ` ${others} other ${others === 1 ? 'fix is' : 'fixes are'} on record.`;
  return ascii(text) + note;
}

// --- the tool --------------------------------------------------------------

export function callTool(name, args, { book = memory, now = Date.now() } = {}) {
  if (name !== TOOL.name) return { error: { code: -32602, message: `Unknown tool: ${ascii(name)}` } };

  const raw = args?.error_text;
  if (typeof raw !== 'string' || !raw.trim()) {
    // A tool-level complaint, not a protocol error: the agent should see it and
    // fix its call, which is what isError is for.
    return {
      result: {
        content: [{ type: 'text', text: 'errorbook_lookup needs error_text: the error output to look up.' }],
        isError: true,
      },
    };
  }

  const truncated = raw.length > MAX_ERROR_TEXT;
  const text = truncated ? raw.slice(0, MAX_ERROR_TEXT) : raw;
  const found = answer(text, { memory: book, now });

  if (!found) {
    return {
      result: {
        content: [{
          type: 'text',
          text: `${sentence(null, { truncated })}\n\n${JSON.stringify({ kind: 'none', errorId: null, summary: '', fix: null, alternatives: [] }, null, 2)}`,
        }],
      },
    };
  }
  return {
    result: {
      content: [{
        type: 'text',
        // The sentence first, then exactly the document `lookup --json` prints.
        text: `${sentence(found, { truncated })}\n\n${JSON.stringify(found.json, null, 2)}`,
      }],
    },
  };
}

// --- the protocol ----------------------------------------------------------

// One request in, one response out (or null for a notification, which must
// never be answered). Throws nothing: an unexpected failure becomes -32603.
export function handleMessage(message, context = {}) {
  const { id = null, method, params } = message ?? {};
  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  const fail = (code, msg) => ({ jsonrpc: '2.0', id, error: { code, message: msg } });
  const notification = message?.id === undefined;

  if (typeof method !== 'string') {
    return notification ? null : fail(-32600, 'Invalid Request');
  }
  // A request with no id is a notification: it is acted on and never answered,
  // whatever it asks for. Answering one desynchronises a client that is not
  // waiting for a reply.
  if (notification) return null;

  try {
    switch (method) {
      case 'initialize':
        return reply({
          // Echo the client's version when it named one, so the handshake
          // agrees rather than arguing.
          protocolVersion: ascii(params?.protocolVersion) || PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: NAME, version: VERSION },
        });
      // Normally sent as a notification and so already answered with silence
      // above; a client that gives it an id gets an empty result rather than a
      // hang.
      case 'notifications/initialized':
      case 'initialized':
        return reply({});
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: [TOOL] });
      case 'tools/call': {
        const outcome = callTool(params?.name, params?.arguments, context);
        if (outcome.error) return fail(outcome.error.code, outcome.error.message);
        return reply(outcome.result);
      }
      default:
        return fail(-32601, `Method not found: ${ascii(method)}`);
    }
  } catch (error) {
    context.log?.(`${method} failed: ${ascii(error?.message)}`);
    return fail(-32603, 'Internal error');
  }
}

// --- the stdio loop --------------------------------------------------------

export function runMcp(deps = {}) {
  const stdin = deps.stdin ?? process.stdin;
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const context = {
    book: deps.memory ?? memory,
    now: deps.now ?? Date.now(),
    log: (text) => stderr.write(`[errorbook mcp] ${ascii(text)}\n`),
  };

  // Protocol only. Nothing else in this file writes to stdout.
  const send = (message) => {
    if (message) stdout.write(`${JSON.stringify(message)}\n`);
  };

  const line = (text) => {
    const trimmed = text.trim();
    if (!trimmed) return; // keep-alive newlines are not messages
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      // The id is unknowable in unparseable text, so it is null by the spec.
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
      return;
    }
    send(handleMessage(message, context));
  };

  return new Promise((resolve) => {
    let buffer = '';
    stdin.setEncoding?.('utf8');
    stdin.on('data', (chunk) => {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const text = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        // One bad message must not take the server down: an agent would see a
        // dead tool rather than an error it could act on.
        try {
          line(text);
        } catch (error) {
          context.log(`dropped a message: ${error?.message}`);
        }
      }
      if (buffer.length > MAX_LINE) {
        context.log(`discarded ${buffer.length} bytes with no newline in them`);
        buffer = '';
        send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      }
    });
    // Exit cleanly when the client goes away, which is how an MCP client stops
    // a stdio server.
    const done = () => {
      if (buffer.trim()) {
        try {
          line(buffer);
        } catch { /* nothing left to do with it */ }
      }
      buffer = '';
      resolve(0);
    };
    stdin.on('end', done);
    stdin.on('close', done);
    stdin.on('error', (error) => {
      context.log(`stdin: ${error?.message}`);
      resolve(0);
    });
    stdin.resume?.();
  });
}
