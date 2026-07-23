// VAPID web-push tests: key shape, JWT structure + signature verification, and
// dead-subscription handling. Runs on `bun test`, offline (fetch is mocked).

import { test, expect, afterEach } from 'bun:test';
import {
  WebPushService,
  generateVapidKeys,
  base64urlDecode,
  base64urlEncode,
} from '../src/notifications/webpush.js';

const dec = new TextDecoder();
const enc = new TextEncoder();

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test('generateVapidKeys returns decodable keys of the right byte lengths', async () => {
  const { publicKey, privateKey } = await generateVapidKeys();
  const pub = base64urlDecode(publicKey);
  const priv = base64urlDecode(privateKey);
  expect(pub.length).toBe(65); // 0x04 || X(32) || Y(32)
  expect(pub[0]).toBe(0x04);
  expect(priv.length).toBe(32);
  // Round-trips through our base64url helpers.
  expect(base64urlEncode(pub)).toBe(publicKey);
});

test('send builds a VAPID-authenticated bodyless POST with a valid ES256 JWT', async () => {
  const keys = await generateVapidKeys();
  const svc = new WebPushService({ ...keys, subject: 'mailto:admin@example.com' });

  let captured;
  globalThis.fetch = async (url, init) => {
    captured = { url, init };
    return new Response('', { status: 201 });
  };

  const now = 1700000000000;
  const res = await svc.send({ endpoint: 'https://push.example.com/abc' }, { now });
  expect(res).toEqual({ ok: true, status: 201 });

  // Request shape.
  expect(captured.url).toBe('https://push.example.com/abc');
  expect(captured.init.method).toBe('POST');
  expect(captured.init.body).toBe(''); // bodyless
  const auth = captured.init.headers.Authorization;
  expect(auth.startsWith('vapid t=')).toBe(true);
  expect(auth).toContain('k=');
  expect(auth).toContain(`k=${keys.publicKey}`);
  expect(captured.init.headers.TTL).toBeDefined();
  expect(captured.init.headers['Content-Length']).toBe('0');

  // Extract the JWT: "vapid t=<jwt>, k=<pub>"
  const jwt = auth.slice('vapid t='.length, auth.indexOf(', k='));
  const [h, p, s] = jwt.split('.');
  const header = JSON.parse(dec.decode(base64urlDecode(h)));
  const payload = JSON.parse(dec.decode(base64urlDecode(p)));

  expect(header.alg).toBe('ES256');
  expect(header.typ).toBe('JWT');
  expect(payload.aud).toBe('https://push.example.com');
  expect(payload.sub).toBe('mailto:admin@example.com');
  expect(payload.exp).toBe(Math.floor(now / 1000) + 12 * 60 * 60);

  // Verify the signature against the public application-server key.
  const pubKey = await crypto.subtle.importKey(
    'raw',
    base64urlDecode(keys.publicKey),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  const ok = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    pubKey,
    base64urlDecode(s),
    enc.encode(`${h}.${p}`),
  );
  expect(ok).toBe(true);
});

test('send passes through TTL, urgency, and topic', async () => {
  const keys = await generateVapidKeys();
  const svc = new WebPushService({ ...keys, subject: 'https://example.com/contact' });

  let headers;
  globalThis.fetch = async (_url, init) => {
    headers = init.headers;
    return new Response('', { status: 200 });
  };

  await svc.send(
    { endpoint: 'https://push.example.com/x' },
    { ttl: 60, urgency: 'high', topic: 'sync', now: 1700000000000 },
  );
  expect(headers.TTL).toBe('60');
  expect(headers.Urgency).toBe('high');
  expect(headers.Topic).toBe('sync');
});

test('send returns { ok:false, gone:true } for a 410 subscription', async () => {
  const keys = await generateVapidKeys();
  const svc = new WebPushService({ ...keys, subject: 'mailto:admin@example.com' });

  globalThis.fetch = async () => new Response('', { status: 410 });

  const res = await svc.send({ endpoint: 'https://push.example.com/dead' }, { now: 1700000000000 });
  expect(res.ok).toBe(false);
  expect(res.gone).toBe(true);
  expect(res.status).toBe(410);
});

test('constructor validates keys and subject', () => {
  expect(() => new WebPushService({ subject: 'mailto:a@b.com' })).toThrow();
  expect(
    () => new WebPushService({ publicKey: 'x', privateKey: 'y', subject: 'not-a-url' }),
  ).toThrow();
});
