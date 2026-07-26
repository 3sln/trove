// Probe: the one screen that answers "why does my agent say 401".
//
// The MCP endpoint can be perfectly implemented and still be unusable, because the piece
// only the self-hoster can supply — which identity provider issues the tokens — has no
// default. There is a state where the drive requires a token, has nowhere to send a
// client to get one, and looks completely configured. That state is why this section
// exists.
//
// It is READ-ONLY: the authorization server is a property of the deployment, not a
// preference, and it is the same value the JSON API's 401s use. So what's checked here
// is that the screen reports the truth — including the gap — and that the truth follows
// the deployment's own configuration rather than anything set from a browser.

import { boot, checker } from './harness.mjs';

const { check, done } = checker();

const { page, close, goto, base, errors } = await boot({
  // Auth demanded, nowhere to authenticate — the broken-but-plausible state.
  serverConfig: { mcp: { requireAuth: true } },
  seed: async (vfs) => { await vfs.writeFile('note.txt', 'hello', { contentType: 'text/plain' }); },
});
await goto();
await page.waitForSelector('.launch-item', { timeout: 5000 });

const openSettings = async () => {
  await page.evaluate(() => window.__trove.platform.commands.execute('workbench.openSettings'));
  await page.waitForSelector('.settings', { timeout: 4000 });
};
await openSettings();

const settingsText = () => page.locator('.settings').innerText();
const text = await settingsText();

// --- 1. The URL a person has to paste somewhere -------------------------------
check('Settings has an MCP section', /AI agents \(MCP\)/i.test(text));
check('and shows the URL to paste into an assistant', text.includes(`${base}/mcp`),
  (text.match(/https?:\/\/\S+/g) || []).join(' '));
// A settings page shows state, not just controls. Nothing here should read like a
// serialized object — that is the tell for a value the UI can't render.
check('no setting renders as a raw object', !/\[object Object\]/.test(text), text.slice(0, 120));

// --- 2. Read-only, because this is deployment configuration --------------------
// It used to be an editable field with a Save button. An HTTP call that redirects
// every future sign-in is a bigger lever than a settings input looks like.
const group = page.locator('.settings .group', { hasText: 'AI agents' });
check('the authorization server is reported, not editable',
  (await group.locator('input').count()) === 0 && (await group.locator('.btn.primary').count()) === 0);
check('and it names the env var to set instead', /TROVE_AUTH_SERVER/.test(text));

// --- 3. The failure that looks like success -----------------------------------
check('the missing authorization server is called out as a problem',
  (await page.locator('.mcp-warn').count()) === 1);
const warn = await page.locator('.mcp-warn').innerText();
check('and the warning says exactly what to set', /TROVE_AUTH_SERVER|issuer URL/i.test(warn), warn.replace(/\n/g, ' '));

// The server agrees, which is what a client will actually hit.
const cold = await page.evaluate(async (b) => {
  const res = await fetch(`${b}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  return { status: res.status, challenge: res.headers.get('www-authenticate') };
}, base);
check('an agent connecting right now gets 401', cold.status === 401);
check('with a pointer to the discovery document', /resource_metadata="[^"]+"/.test(cold.challenge || ''), cold.challenge);
check('and a challenge that says what is missing', /No authorization server/.test(cold.challenge || ''));

await page.locator('.mcp-warn').scrollIntoViewIfNeeded();
await page.screenshot({ path: new URL('../screens/24-mcp-settings.png', import.meta.url).pathname });

// --- 4. One answer for the whole drive ----------------------------------------
// The generalization: this is not MCP's authorization server, it is the drive's. A
// client that never touches MCP gets pointed at the same place.
const api = await page.evaluate(async (b) => {
  const res = await fetch(`${b}/api/items`, { headers: { authorization: 'Bearer not.a.real.token' } });
  return { status: res.status, challenge: res.headers.get('www-authenticate') };
}, base);
check('the drive is open here, so the API does not refuse', api.status !== 401, String(api.status));

const docs = await page.evaluate(async (b) => ({
  drive: await (await fetch(`${b}/.well-known/oauth-protected-resource`)).json(),
  mcp: await (await fetch(`${b}/.well-known/oauth-protected-resource/mcp`)).json(),
}), base);
check('the drive publishes its own discovery document', docs.drive.resource === base, docs.drive.resource);
check('and the MCP one names the endpoint', docs.mcp.resource === `${base}/mcp`, docs.mcp.resource);
check('both agree on where to sign in',
  JSON.stringify(docs.drive.authorization_servers) === JSON.stringify(docs.mcp.authorization_servers),
  `${JSON.stringify(docs.drive.authorization_servers)} vs ${JSON.stringify(docs.mcp.authorization_servers)}`);

// This probe deliberately provokes a 401 from the MCP endpoint; the browser logs it as
// a console error. That 401 is the feature working, and it was asserted on above.
const real = errors.filter((e) => !e.includes('net::ERR_ABORTED')
  && !/Failed to load resource.*\b401\b/.test(e));
check('no uncaught errors along the way', real.length === 0, real.slice(0, 4).join(' | '));
done();
await close();
