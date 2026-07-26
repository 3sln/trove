// Probe: the one screen that answers "why does my agent say 401".
//
// The MCP endpoint can be perfectly implemented and still be unusable, because the piece
// only the self-hoster can supply — which identity provider issues the tokens — has no
// default. There is a state where the drive requires a token, has nowhere to send an
// agent to get one, and looks completely configured. That state is the entire reason
// this screen exists, so what is checked here is that it is NAMED, that the URL to paste
// into an agent is visible, and that fixing it takes effect without a redeploy.

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
  await page.waitForFunction(() => !/Checking…/.test(document.querySelector('.settings')?.innerText || ''), null, { timeout: 5000 });
};
await openSettings();

const settingsText = () => page.locator('.settings').innerText();

// --- 1. The URL a person has to paste somewhere -------------------------------
const text = await settingsText();
check('Settings has an MCP section', /AI agents \(MCP\)/i.test(text));
check('and shows the URL to paste into an assistant', text.includes(`${base}/mcp`),
  (text.match(/https?:\/\/\S+/g) || []).join(' '));

// --- 2. The failure that looks like success -----------------------------------
check('the missing authorization server is called out as a problem',
  (await page.locator('.mcp-warn').count()) === 1);
const warn = await page.locator('.mcp-warn').innerText();
check('and the warning says what to do about it', /issuer URL/i.test(warn), warn.replace(/\n/g, ' '));

// The server agrees, which is what an agent will actually hit.
const cold = await page.evaluate(async (b) => {
  const res = await fetch(`${b}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  return { status: res.status, challenge: res.headers.get('www-authenticate') };
}, base);
check('an agent connecting right now gets 401', cold.status === 401);
check('with a pointer to the discovery document', /resource_metadata="[^"]+"/.test(cold.challenge || ''), cold.challenge);
check('and a challenge that says what is missing', /No MCP authorization server/.test(cold.challenge || ''));

// A settings page shows state, not just controls. Nothing here should read like a
// serialized object — that is the tell for a value the UI doesn't actually know how to
// render, and it used to sit at the very top of this screen.
check('no setting renders as a raw object', !/\[object Object\]/.test(text), text.slice(0, 120));

await page.locator('.mcp-warn').scrollIntoViewIfNeeded();
await page.screenshot({ path: new URL('../screens/24-mcp-settings.png', import.meta.url).pathname });

// --- 3. Fixing it, without touching the server ---------------------------------
await page.fill('.settings .group:has(.mcp-warn) input.input', 'https://auth.example.com');
await page.click('.settings .group:has(.mcp-warn) .row-actions .btn.primary');
await page.waitForTimeout(600);
await page.waitForFunction(() => !/Checking…/.test(document.querySelector('.settings')?.innerText || ''), null, { timeout: 5000 });

check('the warning clears once an authorization server is set',
  (await page.locator('.mcp-warn').count()) === 0, await settingsText());

// And an agent's discovery now names it — the whole point of setting it.
const doc = await page.evaluate(async (b) => {
  const res = await fetch(`${b}/.well-known/oauth-protected-resource/mcp`);
  return { status: res.status, body: await res.json() };
}, base);
check('the discovery document now names it', doc.body.authorization_servers?.[0] === 'https://auth.example.com',
  JSON.stringify(doc.body));
check('and still names this endpoint as the resource', doc.body.resource === `${base}/mcp`, doc.body.resource);

// --- 4. It refuses a downgrade -------------------------------------------------
// An agent hands a bearer token to whatever this names, so plaintext is either a typo
// or an attack, and the UI must not accept it quietly.
// Clear the success toast first, so what is asserted below is the REJECTION and not a
// leftover message from the save that worked.
await page.evaluate(() => window.__trove.platform.notifications.items
  .forEach((n) => window.__trove.platform.notifications.dismiss(n.id)));
await page.fill('.settings input.input[placeholder="https://auth.example.com"]', 'http://evil.example.com');
await page.click('.settings .row-actions .btn.primary');
await page.waitForTimeout(700);
const after = await page.evaluate(async (b) => (await (await fetch(`${b}/.well-known/oauth-protected-resource/mcp`)).json()), base);
check('a plaintext authorization server is rejected and the old one kept',
  after.authorization_servers?.[0] === 'https://auth.example.com', JSON.stringify(after));
const toast = await page.locator('.toasts').innerText().catch(() => '');
check('and the user is told why, in terms they can act on', /https/i.test(toast) && !/Saved/.test(toast),
  toast.replace(/\n/g, ' | ') || '(no toast)');

// This probe deliberately provokes two rejections — an unauthenticated MCP request and a
// plaintext authorization server. The browser logs both as console errors; both are the
// feature working, and both were asserted on above.
const real = errors.filter((e) => !e.includes('net::ERR_ABORTED')
  && !/Failed to load resource.*\b(400|401)\b/.test(e));
check('no uncaught errors along the way', real.length === 0, real.slice(0, 4).join(' | '));
done();
await close();
