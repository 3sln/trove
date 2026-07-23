// Cloudflare Worker adapter. A Worker's fetch handler is already Web-standard,
// so this is thin. Storage should be S3-compatible (R2 via the S3 API) so the
// SigV4 signer and presigned URLs work; metadata can be a D1-backed MetadataStore
// (implement the interface over env.DB) — passed in via `buildVfs`. Static assets
// are served from the [site]/assets binding when configured.
//
// wrangler.toml sketch:
//   [vars] TROVE_S3_BUCKET = "..."  TROVE_S3_REGION = "auto"
//   TROVE_S3_ENDPOINT = "https://<acct>.r2.cloudflarestorage.com"
//   (secrets: TROVE_S3_ACCESS_KEY_ID, TROVE_S3_SECRET_ACCESS_KEY)

import { createServer, configFromEnv } from '../index.js';

let cached = null;

/**
 * @param {object} env Worker env bindings
 * @param {(env) => object} [buildVfs] optional: return { storage, metadata } (e.g. D1)
 */
async function getServer(env, buildVfs) {
  if (cached) return cached;
  const config = configFromEnv(env);
  if (buildVfs) config.vfs = buildVfs(env);
  // Cloudflare Vectorize binding → first-class vector store (no REST creds needed).
  if (env.VECTORIZE) {
    config.vectorStore = { driver: 'vectorize', binding: env.VECTORIZE };
  }
  // Serve static assets from the ASSETS binding (Workers Sites / assets).
  if (env.ASSETS) {
    config.assets = async (req) => {
      const res = await env.ASSETS.fetch(req);
      return res.status === 404 ? null : res;
    };
  }
  cached = await createServer(config);
  return cached;
}

/** Default export usable directly as a Worker module. */
export default {
  async fetch(request, env, ctx) {
    const { handle } = await getServer(env);
    return handle(request);
  },
};

export { getServer };
