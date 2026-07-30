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
      // S3Storage takes the config flat; the old switch passed `cfg.s3`, which meant a
      // collection record had to nest its own settings one level deeper than every
      // other driver for no reason a user could see.
      create: (cfg) => new S3Storage({
        bucket: cfg.bucket,
        region: cfg.region || 'auto',
        endpoint: cfg.endpoint || undefined,
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
        sessionToken: cfg.sessionToken,
        forcePathStyle: cfg.forcePathStyle === true || cfg.forcePathStyle === 'true',
        ...(cfg.s3 || {}),
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
