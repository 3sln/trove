// Does a drive configured the way deployments are actually configured start up?
//
// Every other test builds config as an object literal, in the flat shape the collection
// form posts. Real deployments — the Docker image, the Worker, anything with a
// wrangler.toml — go through `configFromEnv`, which produces a DIFFERENT shape: S3
// settings nested under `s3`, booleans as the strings "true" and "false".
//
// That gap let a regression through that broke every environment-configured S3 drive at
// startup with `Storage driver "s3" requires "bucket"` — on a drive whose bucket was set
// correctly. It survived a full green suite and was caught by running the app.
//
// So: boot from an environment, and ask for something that has to touch the store.

import { test, expect } from 'bun:test';
import { createServer, configFromEnv } from '../src/index.js';

const S3_ENV = {
  TROVE_STORAGE: 's3',
  TROVE_S3_BUCKET: 'trove',
  TROVE_S3_REGION: 'auto',
  TROVE_S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
  TROVE_S3_ACCESS_KEY_ID: 'AKIAEXAMPLE',
  TROVE_S3_SECRET_ACCESS_KEY: 'secret',
  TROVE_METADATA: 'memory',
  TROVE_AUTH: 'anonymous',
  TROVE_ADMINS: 'anonymous',
  TROVE_VECTOR: 'memory',
  TROVE_MCP: 'off',
  TROVE_AUTH_REQUIRED: 'false',
};

const boot = (env) => createServer({ ...configFromEnv(env), rebuildIndexOnStart: false });

test('an S3 drive configured from the environment starts and serves', async () => {
  const server = await boot(S3_ENV);
  // /api/health does not touch the store; /api/capabilities resolves it, which is where
  // the failure actually landed — a 500 on every request from the first one.
  const health = await server.handle(new Request('https://drive.test/api/health'));
  expect(health.status).toBe(200);
  const caps = await server.handle(new Request('https://drive.test/api/capabilities'));
  expect(caps.status).toBe(200);
  const body = await caps.json();
  expect(body.storage.presignDownload).toBe(true);
});

test('the Workers shape starts too: S3 plus a restricted driver set', async () => {
  // What trove-app's wrangler.toml says, which is the configuration that found the bug.
  const server = await boot({ ...S3_ENV, TROVE_STORAGE_DRIVERS: 's3', TROVE_DEFAULT_OPEN: 'false' });
  const caps = await (await server.handle(new Request('https://drive.test/api/capabilities'))).json();
  expect(caps.storageDrivers.map((d) => d.key)).toEqual(['s3']);
  expect(caps.storage.presignDownload).toBe(true);
});

test('a bucket that really is missing is still refused, and says so', async () => {
  // Normalising the nested shape must not have turned validation off.
  const { TROVE_S3_BUCKET, ...noBucket } = S3_ENV;
  await expect(boot(noBucket)).rejects.toThrow(/requires "bucket"/);
});

test('TROVE_STORAGE=filesystem without an entry point that has one is refused clearly', async () => {
  // `createServer` on its own registers only the portable drivers — Filesystem comes from
  // the Node and Bun entry points, because it is what drags node:fs into a bundle. So this
  // configuration IS wrong here, and the point of the test is that it says which part:
  // named-but-absent, with the available set, rather than a stack trace about node:fs or a
  // silent fall back to memory (which is what the old `default:` arm did).
  await expect(boot({ ...S3_ENV, TROVE_STORAGE: 'filesystem' }))
    .rejects.toThrow(/Unknown storage driver "filesystem" — this deployment has: s3, memory/);
});
