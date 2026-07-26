// Does a real MCP client actually connect?
//
// Every unit test in mcp.test.js asserts against a shape I chose. This one hands the
// server to the reference SDK — the same code inside the clients people will point at
// this drive — and lets it decide. That difference matters more here than almost
// anywhere else in the project, because the failure mode of an MCP server is a client
// that silently "can't connect" with nothing in either log worth reading.
//
// It also walks the discovery half the way an agent does: hit the endpoint cold, read
// the 401, follow the pointer to the metadata, and end up somewhere it can get a token.
// The SDK's own auth code does that parsing, so if the header is malformed this fails.
//
// Run: node packages/server/test/mcp-client.e2e.mjs
// The SDK is a devDependency of this check only; if it isn't installed, this skips.

import http from 'node:http';
import { Readable } from 'node:stream';
import { createServer } from '../src/index.js';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

let Client; let StreamableHTTPClientTransport; let auth;
try {
  ({ Client } = await import('@modelcontextprotocol/sdk/client/index.js'));
  ({ StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js'));
  auth = await import('@modelcontextprotocol/sdk/client/auth.js');
} catch (err) {
  console.log('· @modelcontextprotocol/sdk is not installed — skipping the real-client check.');
  console.log('  npm install --no-save @modelcontextprotocol/sdk');
  process.exit(0);
}

async function toWeb(nodeReq, base) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(nodeReq.headers)) if (v) headers.set(k, Array.isArray(v) ? v.join(',') : v);
  const hasBody = nodeReq.method !== 'GET' && nodeReq.method !== 'HEAD';
  return new Request(`${base}${nodeReq.url}`, {
    method: nodeReq.method, headers, body: hasBody ? Readable.toWeb(nodeReq) : undefined, duplex: 'half',
  });
}

/** Boot a real HTTP server in front of the Trove handler. */
async function listen(config) {
  const trove = await createServer({ rebuildIndexOnStart: false, ...config });
  const server = http.createServer(async (req, res) => {
    try {
      const webRes = await trove.handle(await toWeb(req, 'http://localhost'));
      res.statusCode = webRes.status;
      webRes.headers.forEach((v, k) => res.setHeader(k, v));
      if (webRes.body) Readable.fromWeb(webRes.body).pipe(res);
      else res.end();
    } catch (e) {
      res.statusCode = 500;
      res.end(String(e?.stack || e));
    }
  });
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  return { trove, server, base, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

// --- 1. An open drive: the reference client connects and uses it ---------------

const open = await listen({});
await open.trove.vfs.writeFile('welcome.md', '# Welcome\n\nNotes on sailing and the boat refit.\n', { contentType: 'text/markdown' });
await open.trove.vfs.writeFile('recipe.txt', 'flour, water, salt', { contentType: 'text/plain' });

const client = new Client({ name: 'trove-conformance-check', version: '1.0.0' }, { capabilities: {} });
const transport = new StreamableHTTPClientTransport(new URL(`${open.base}/mcp`));
try {
  await client.connect(transport);
  check('the reference MCP client completes the handshake', true);
} catch (err) {
  check('the reference MCP client completes the handshake', false, err?.message);
}

const version = client.getServerVersion();
check('and reads back the server identity', version?.name === 'trove', JSON.stringify(version));
check('with instructions telling the model there are no folders',
  /NO FOLDERS/i.test(client.getInstructions() || ''), (client.getInstructions() || '').slice(0, 60));

const { tools } = await client.listTools();
check('the SDK parses every tool schema without complaint', tools.length >= 6, tools.map((t) => t.name).join(', '));

const searched = await client.callTool({ name: 'search_files', arguments: { query: 'sailing' } });
check('search runs through the real client', !searched.isError && searched.content[0].text.includes('welcome.md'),
  searched.content[0].text.slice(0, 80));

const read = await client.callTool({ name: 'read_file', arguments: { file: 'recipe.txt' } });
check('read_file returns the file contents', read.content[0].text === 'flour, water, salt', read.content[0].text);

const written = await client.callTool({ name: 'write_file', arguments: { name: 'from-agent.md', content: '# Written by an agent\n' } });
check('write_file creates a real file on the drive',
  !written.isError && !!(await open.trove.vfs.find('from-agent.md')), written.content[0].text);

// A hallucinated tool must come back as a readable result, not a protocol fault that
// tears down the connection.
const ghost = await client.callTool({ name: 'not_a_real_tool', arguments: {} });
check('an unknown tool is a readable failure, not a dropped connection', ghost.isError === true, ghost.content?.[0]?.text);
const stillAlive = await client.listTools();
check('and the session survives it', stillAlive.tools.length === tools.length);

// Resources, for clients that attach context rather than calling tools.
const { resources } = await client.listResources();
check('resources are listed under trove: URIs', resources.some((r) => r.uri.startsWith('trove:')),
  resources.slice(0, 2).map((r) => r.uri).join(' '));
const resource = await client.readResource({ uri: resources.find((r) => r.name === 'recipe.txt').uri });
check('and one can be read back', resource.contents[0].text === 'flour, water, salt');

await client.close().catch(() => {});
await open.close();

// --- 2. A protected drive: the SDK's own auth code follows our 401 -------------

const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const publicJwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' };
const b64url = (b) => Buffer.from(b).toString('base64url');
const enc = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
async function sign(claims) {
  const input = `${enc({ alg: 'ES256', typ: 'JWT', kid: 'k1' })}.${enc({ exp: Math.floor(Date.now() / 1000) + 3600, ...claims })}`;
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(input));
  return `${input}.${b64url(new Uint8Array(sig))}`;
}

const locked = await listen({
  identity: { driver: 'jwt', jwt: { jwks: { keys: [publicJwk] }, required: true } },
  mcp: { authorizationServers: ['https://auth.example.com'] },
});
await locked.trove.vfs.writeFile('private.txt', 'for authorized eyes', { contentType: 'text/plain' });

// Cold: no token. This is the exact request an agent makes the first time.
const cold = await fetch(`${locked.base}/mcp`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
});
check('an agent with no token gets 401', cold.status === 401);

// Let the SDK parse our challenge. If the header is malformed this returns nothing, and
// the client has a dead end instead of a sign-in.
const parsed = auth.extractResourceMetadataUrl
  ? auth.extractResourceMetadataUrl(cold)
  : new URL((cold.headers.get('www-authenticate').match(/resource_metadata="([^"]+)"/) || [])[1]);
check('the SDK finds the metadata pointer in our WWW-Authenticate header',
  !!parsed && String(parsed).endsWith('/.well-known/oauth-protected-resource/mcp'), String(parsed));

// And follow it, the way the client's auth flow does.
const doc = await (await fetch(String(parsed))).json();
check('the metadata document names an authorization server',
  doc.authorization_servers?.[0] === 'https://auth.example.com', JSON.stringify(doc));
check('and names this endpoint as the resource', doc.resource === `${locked.base}/mcp`, doc.resource);

// With a token, the same client works — same JWT the browser presents.
const token = await sign({ sub: 'alice@example.com', email: 'alice@example.com' });
const authed = new Client({ name: 'trove-conformance-check', version: '1.0.0' }, { capabilities: {} });
const authedTransport = new StreamableHTTPClientTransport(new URL(`${locked.base}/mcp`), {
  requestInit: { headers: { authorization: `Bearer ${token}` } },
});
try {
  await authed.connect(authedTransport);
  const r = await authed.callTool({ name: 'read_file', arguments: { file: 'private.txt' } });
  check('the drive\'s own JWT authenticates the agent', r.content[0].text === 'for authorized eyes', r.content[0].text);
} catch (err) {
  check('the drive\'s own JWT authenticates the agent', false, err?.message);
}
await authed.close().catch(() => {});
await locked.close();

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
