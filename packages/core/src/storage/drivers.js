// The drivers this package ships, as registrable descriptors.
//
// Split by what a runtime can actually run, and that split is the point:
//
//   `portableDrivers()` — memory and S3. Both are fetch-and-arithmetic, so they work
//   identically on Node, Bun, Deno and Cloudflare Workers.
//
//   `filesystemDriver()` — lives in filesystem.js and is imported from there, NOT from
//   this module or the package barrel. That import is what pulls in node:fs, so a Workers
//   entry point that never mentions it never gets it: the driver is absent from the form
//   AND absent from the bundle. Re-exporting it here would defeat both.
//
// A deployment's driver set is therefore decided by its entry point, which is the only
// place that knows what it is running on.

import { MemoryStorage } from './memory.js';
import { S3Storage } from './s3.js';

/** Anything with a `fetch` can run these. */
export function portableDrivers() {
  return [
    {
      key: 's3',
      label: 'S3-compatible',
      description: 'AWS S3, Cloudflare R2, MinIO, Backblaze B2 — anything speaking the S3 API.',
      fields: [
        { name: 'bucket', label: 'Bucket', required: true, placeholder: 'my-bucket' },
        {
          name: 'region',
          label: 'Region',
          placeholder: 'auto',
          help: 'R2 uses "auto". AWS wants the bucket’s real region.',
        },
        {
          name: 'endpoint',
          label: 'Endpoint',
          placeholder: 'https://<account>.r2.cloudflarestorage.com',
          help: 'Leave blank for AWS S3.',
        },
        { name: 'prefix', label: 'Prefix', help: 'Share one bucket between collections.' },
        // Marked secret so they are never read back out of a collection record: the
        // record lives in the KV store and is otherwise safe to show an admin.
        { name: 'accessKeyId', label: 'Access key id', required: true, secret: true },
        { name: 'secretAccessKey', label: 'Secret access key', type: 'password', required: true, secret: true },
        {
          name: 'forcePathStyle',
          label: 'Path-style addressing',
          type: 'boolean',
          help: 'MinIO and most self-hosted endpoints need this.',
        },
      ],
      // Two config shapes reach here and both have to work.
      //
      // Flat — `{ driver: 's3', bucket: … }` — is what `fields` above describes and what
      // the collection form posts. Nested under `s3` is what `configFromEnv` produces and
      // what every collection record written before this driver existed holds, because the
      // switch this replaced read `cfg.s3` and nothing else.
      //
      // Normalising rather than only handling it in `create` is the point: validation runs
      // against the normalised shape, so a nested config is no longer refused for a missing
      // top-level `bucket` that was about to be spread in anyway. That refusal broke every
      // environment-configured S3 deployment at startup, which is as loud as a bug gets and
      // still took a local run to see, because no test used the env shape.
      normalize: (cfg) => ({ ...cfg, ...(cfg.s3 || {}) }),
      create: (cfg) => new S3Storage({
        bucket: cfg.bucket,
        region: cfg.region || 'auto',
        endpoint: cfg.endpoint || undefined,
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
        sessionToken: cfg.sessionToken,
        forcePathStyle: cfg.forcePathStyle === true || cfg.forcePathStyle === 'true',
      }),
    },
    {
      key: 'memory',
      label: 'Memory',
      description: 'Nothing is kept. For demos and tests — a restart empties it.',
      fields: [],
      create: () => new MemoryStorage(),
    },
  ];
}
