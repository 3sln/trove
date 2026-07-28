// The interview.
//
// Answers only — nothing here touches the filesystem, and nothing here knows what a
// wrangler.toml looks like. That split is what lets the whole wizard be tested from a
// transcript (see test/wizard.test.js): drive it with a scripted prompter, assert on the
// plan, and never mkdir anything.
//
// Two rules shape the questions:
//
//   Skipping is an answer, not an escape. Every section can be declined, and declining
//   still puts the section in the generated config — commented, with the keys that
//   belong in it and a line saying what they are for. Someone who already knows their
//   R2 credentials should not be interviewed about them, and someone who does not should
//   not be blocked from getting a project on disk.
//
//   Secrets are never values. A credential answered here becomes a `wrangler secret put`
//   step on Workers and an untracked `.env` line elsewhere — it never lands in a file
//   that belongs in version control. `secret: true` on an entry is what carries that.

export const RUNTIMES = ['bun', 'node', 'workers'];

/** An environment/config entry. `secret` keeps it out of anything committed. */
const entry = (key, value, { comment, secret = false, commented = false } = {}) =>
  ({ key, value, comment, secret, commented });

/** A declined section still emits its keys, commented, so the file documents itself. */
const placeholder = (key, comment) => entry(key, '', { comment, commented: true });

/**
 * Run the interview.
 *
 * @param {object} prompter from ./prompt.js — real or scripted
 * @param {object} opts
 * @param {string} opts.name project directory name
 * @param {string} opts.version the @3sln/trove version to pin (this package's own —
 *   the two are released together, so they are the same number by construction)
 * @param {string} [opts.runtime] pre-answered by --runtime
 * @returns {Promise<object>} the plan
 */
export async function askPlan(prompter, { name, version, runtime: preset }) {
  const runtime = preset ?? await prompter.choice('Where will this run?', [
    { value: 'bun', label: 'Bun', hint: 'recommended for self-hosting' },
    { value: 'node', label: 'Node', hint: 'identical behaviour, a little slower' },
    { value: 'workers', label: 'Cloudflare Workers', hint: 'no disk — D1, Vectorize and R2 do the work' },
  ], { default: 'bun' });

  const isWorkers = runtime === 'workers';
  const plan = { name, version, runtime, sections: [], workers: null, server: null, skipped: [], warnings: [] };

  const add = (title, entries, { skipped = false } = {}) => {
    plan.sections.push({ title, entries, skipped });
    if (skipped) plan.skipped.push(title);
  };

  // --- storage ---------------------------------------------------------------
  // Workers has no disk, so `filesystem` is not offered there — and R2 is reached
  // through the S3 API rather than a binding because that is what lets presigned
  // uploads go straight to the bucket instead of through the Worker's CPU time.
  if (await prompter.section('Object storage', {
    blurb: isWorkers
      ? 'Where file bytes live. On Workers this is R2 through its S3-compatible API.'
      : 'Where file bytes live.',
  })) {
    const driver = await prompter.choice('  Backend', isWorkers ? [
      { value: 's3', label: 'R2 / S3-compatible' },
      { value: 'memory', label: 'In memory', hint: 'lost when the isolate recycles — demos only' },
    ] : [
      { value: 'filesystem', label: 'Filesystem or NAS mount' },
      { value: 's3', label: 'S3-compatible', hint: 'AWS, R2, MinIO, B2' },
      { value: 'memory', label: 'In memory', hint: 'nothing is kept — demos only' },
    ], { default: isWorkers ? 's3' : 'filesystem' });

    const entries = [entry('TROVE_STORAGE', driver)];
    if (driver === 'filesystem') {
      entries.push(entry('TROVE_FS_ROOT', await prompter.text('  Object root', { default: './data/objects' }),
        { comment: 'the backend creates objects/ under this, sharded two levels deep' }));
    }
    if (driver === 's3') {
      entries.push(entry('TROVE_S3_BUCKET', await prompter.text('  Bucket', { default: 'trove' })));
      entries.push(entry('TROVE_S3_REGION', await prompter.text('  Region', { default: isWorkers ? 'auto' : 'us-east-1' }),
        { comment: 'R2 uses "auto"' }));
      entries.push(entry('TROVE_S3_ENDPOINT', await prompter.text('  Endpoint', {
        default: isWorkers ? 'https://<account-id>.r2.cloudflarestorage.com' : '',
        hint: 'leave blank for AWS S3',
      }), { comment: 'omit for AWS' }));
      entries.push(entry('TROVE_S3_ACCESS_KEY_ID', await prompter.text('  Access key id', { default: '' }), { secret: true }));
      entries.push(entry('TROVE_S3_SECRET_ACCESS_KEY', await prompter.text('  Secret access key', { default: '' }), { secret: true }));
      if (!isWorkers && await prompter.confirm('  Path-style addressing?', { default: false })) {
        entries.push(entry('TROVE_S3_PATH_STYLE', 'true', { comment: 'MinIO and most custom endpoints' }));
      }
    }
    add('Object storage', entries);
  } else {
    add('Object storage', [
      placeholder('TROVE_STORAGE', `memory | ${isWorkers ? '' : 'filesystem | '}s3 — defaults to memory, which keeps nothing`),
      ...(isWorkers ? [] : [placeholder('TROVE_FS_ROOT', 'filesystem root, e.g. ./data/objects')]),
      placeholder('TROVE_S3_BUCKET', 'for TROVE_STORAGE=s3'),
      placeholder('TROVE_S3_REGION', '"auto" for R2'),
      placeholder('TROVE_S3_ENDPOINT', 'e.g. https://<account-id>.r2.cloudflarestorage.com'),
    ], { skipped: true });
  }

  // --- metadata --------------------------------------------------------------
  // On Workers this is D1, which is a binding rather than a variable, so the question
  // moves to the bindings block below.
  if (!isWorkers) {
    if (await prompter.section('Metadata', { blurb: 'The file tree, collections, plugin installs and keyword index.' })) {
      const driver = await prompter.choice('  Store', [
        { value: 'sqlite', label: 'SQLite file', hint: 'one file, backed up with a VACUUM INTO snapshot' },
        { value: 'memory', label: 'In memory', hint: 'lost on restart' },
      ], { default: 'sqlite' });
      const entries = [entry('TROVE_METADATA', driver)];
      if (driver === 'sqlite') {
        entries.push(entry('TROVE_DB_PATH', await prompter.text('  Database path', { default: './data/trove.db' })));
      }
      add('Metadata', entries);
    } else {
      add('Metadata', [
        placeholder('TROVE_METADATA', 'memory | sqlite — defaults to memory, which is lost on restart'),
        placeholder('TROVE_DB_PATH', 'e.g. ./data/trove.db'),
      ], { skipped: true });
    }
  }

  // --- search ----------------------------------------------------------------
  if (await prompter.section('Semantic search', {
    blurb: 'Embeddings turn text into vectors; the vector store holds them. Both have working defaults.',
  })) {
    const entries = [];
    const embed = await prompter.choice('  Embeddings', [
      { value: 'builtin', label: 'Built-in hash embedding', hint: 'offline, no API key, weaker results' },
      { value: 'http', label: 'An HTTP embeddings API', hint: 'OpenAI-compatible' },
    ], { default: 'builtin' });
    if (embed === 'http') {
      entries.push(entry('TROVE_EMBEDDINGS_URL', await prompter.text('  Embeddings URL', { default: 'https://api.openai.com/v1/embeddings' })));
      entries.push(entry('TROVE_EMBEDDINGS_API_KEY', await prompter.text('  API key', { default: '' }), { secret: true }));
      entries.push(entry('TROVE_EMBEDDINGS_MODEL', await prompter.text('  Model', { default: 'text-embedding-3-small' })));
      entries.push(entry('TROVE_EMBEDDINGS_DIM', await prompter.text('  Dimensions', { default: '1536' }),
        { comment: 'must match the model, and changing it means a reindex' }));
    }

    if (isWorkers) {
      // sqlite-vec is a native artifact and cannot load on Workers, so there is no
      // in-process option to fall back to — Vectorize is the only vector store here.
      entries.push(entry('TROVE_VECTOR', 'vectorize', { comment: 'the VECTORIZE binding is picked up automatically' }));
    } else {
      const vector = await prompter.choice('  Vector store', [
        { value: 'memory', label: 'In process', hint: 'sqlite-vec if available, rebuilt on restart otherwise' },
        { value: 'qdrant', label: 'Qdrant' },
      ], { default: 'memory' });
      entries.push(entry('TROVE_VECTOR', vector));
      if (vector === 'qdrant') {
        entries.push(entry('TROVE_QDRANT_URL', await prompter.text('  Qdrant URL', { default: 'http://localhost:6333' })));
        entries.push(entry('TROVE_QDRANT_COLLECTION', await prompter.text('  Collection', { default: 'trove' })));
        entries.push(entry('TROVE_QDRANT_API_KEY', await prompter.text('  API key', { default: '' }), { secret: true }));
      }
    }
    add('Semantic search', entries);
  } else {
    add('Semantic search', [
      placeholder('TROVE_EMBEDDINGS_URL', 'unset uses the built-in offline hash embedding'),
      placeholder('TROVE_VECTOR', isWorkers ? 'vectorize — sqlite-vec cannot run on Workers' : 'memory | qdrant | vectorize'),
    ], { skipped: true });
  }

  // --- identity --------------------------------------------------------------
  // The one section where declining is genuinely dangerous, so the warning is attached
  // to the plan rather than left to the reader to infer.
  if (await prompter.section('Identity', {
    blurb: 'Trove ships no login — it verifies what an IdP or proxy already established.',
  })) {
    const driver = await prompter.choice('  Verify identity via', [
      { value: 'cloudflare-access', label: 'Cloudflare Access / Zero Trust' },
      { value: 'jwt', label: 'A JWT from any OIDC provider', hint: 'verified against a JWKS' },
      { value: 'header', label: 'A header set by a verifying proxy' },
      { value: 'anonymous', label: 'Nobody', hint: 'everyone is the same anonymous user' },
    ], { default: isWorkers ? 'cloudflare-access' : 'anonymous' });

    const entries = [entry('TROVE_AUTH', driver)];
    if (driver === 'cloudflare-access') {
      entries.push(entry('TROVE_CF_ACCESS_TEAM', await prompter.text('  Access team name', { default: '', hint: 'the <team> in <team>.cloudflareaccess.com' })));
      entries.push(entry('TROVE_CF_ACCESS_AUD', await prompter.text('  Application AUD tag', { default: '' })));
      // cloudflare-access is the one driver that requires auth unless told otherwise.
      entries.push(entry('TROVE_AUTH_REQUIRED', 'true', { comment: 'the default for this driver; "false" falls back to anonymous' }));
    } else if (driver === 'jwt') {
      entries.push(entry('TROVE_JWKS_URL', await prompter.text('  JWKS URL', { default: '' })));
      entries.push(entry('TROVE_JWT_ISSUER', await prompter.text('  Issuer', { default: '' })));
      entries.push(entry('TROVE_JWT_AUDIENCE', await prompter.text('  Audience', { default: '' })));
      entries.push(entry('TROVE_AUTH_REQUIRED', String(await prompter.confirm('  Reject unauthenticated requests?', { default: true }))));
    } else if (driver === 'header') {
      entries.push(entry('TROVE_AUTH_ID_HEADER', await prompter.text('  Identity header', { default: 'cf-access-authenticated-user-email' }),
        { comment: 'only safe behind a proxy that sets this and strips it from client requests' }));
      entries.push(entry('TROVE_AUTH_REQUIRED', String(await prompter.confirm('  Reject unauthenticated requests?', { default: true }))));
    }
    if (driver === 'anonymous') plan.warnings.push('anonymous');
    // Naming a driver whose settings were left blank is worse than naming none: the
    // config looks configured. `cloudflare-access` in particular refuses every request
    // it cannot verify, so a blank team is not an open door but a closed one — and
    // either way the reason is a value nobody filled in.
    const REQUIRED = {
      'cloudflare-access': ['TROVE_CF_ACCESS_TEAM', 'TROVE_CF_ACCESS_AUD'],
      jwt: ['TROVE_JWKS_URL', 'TROVE_JWT_ISSUER', 'TROVE_JWT_AUDIENCE'],
    };
    const missing = (REQUIRED[driver] ?? []).filter((k) => !entries.find((e) => e.key === k)?.value);
    if (missing.length) plan.warnings.push({ kind: 'incomplete-identity', driver, missing });
    add('Identity', entries);
  } else {
    plan.warnings.push('anonymous');
    add('Identity', [
      placeholder('TROVE_AUTH', 'anonymous | jwt | cloudflare-access | header — defaults to anonymous'),
      placeholder('TROVE_AUTH_REQUIRED', 'true to reject unauthenticated requests'),
    ], { skipped: true });
  }

  // --- access control --------------------------------------------------------
  if (await prompter.section('Access control', { blurb: 'Who is an admin, and whether the default collection is open to everyone.' })) {
    const admins = await prompter.text('  Admin principal ids', { default: '', hint: 'comma-separated, usually email addresses' });
    const open = await prompter.confirm('  Give everyone full access to the default collection?', { default: false });
    add('Access control', [
      entry('TROVE_ADMINS', admins),
      entry('TROVE_DEFAULT_OPEN', String(open), { comment: 'false means the default collection is not world-writable' }),
    ]);
    if (open) plan.warnings.push('default-open');
  } else {
    plan.warnings.push('default-open');
    add('Access control', [
      placeholder('TROVE_ADMINS', 'comma-separated principal ids with admin'),
      placeholder('TROVE_DEFAULT_OPEN', 'false — otherwise everyone gets the default collection'),
    ], { skipped: true });
  }

  // --- runtime specifics -----------------------------------------------------
  if (isWorkers) {
    plan.workers = await askWorkers(prompter);
  } else {
    plan.server = { port: '8787', host: '0.0.0.0' };
    if (await prompter.section('Server', { blurb: 'Port and bind address.', default: false })) {
      plan.server.port = await prompter.text('  Port', { default: '8787' });
      plan.server.host = await prompter.text('  Host', { default: '0.0.0.0' });
    }
  }

  return plan;
}

/**
 * The Workers bindings.
 *
 * These are not environment variables — they are resources that have to exist in the
 * account before a deploy works, which is why every one of them also produces a command
 * in the plan's steps. A wrangler.toml naming a D1 database that was never created is
 * the single most common way a first Workers deploy fails, and it fails at request time
 * rather than at deploy time.
 */
async function askWorkers(prompter) {
  const w = {
    d1: null, pluginDb: null, vectorize: null, ai: false, tasks: true,
    compatibilityDate: '2024-09-23',
  };

  if (await prompter.section('D1 (metadata)', {
    blurb: 'Bind DB or the drive runs entirely in memory — fine until the isolate recycles, then everything is gone.',
  })) {
    w.d1 = {
      name: await prompter.text('  Database name', { default: 'trove' }),
      id: await prompter.text('  Database id', { default: '', hint: 'from `wrangler d1 create` — leave blank to fill in after' }),
    };
    if (await prompter.confirm('  Bind a second D1 for server-side plugin storage?', { default: false })) {
      w.pluginDb = {
        name: await prompter.text('  Plugin database name', { default: 'trove-plugins' }),
        id: await prompter.text('  Plugin database id', { default: '' }),
      };
    }
  }

  if (await prompter.section('Vectorize (semantic search)', {
    blurb: 'sqlite-vec is a native artifact and cannot load here, so semantic search needs Vectorize.',
  })) {
    w.vectorize = {
      index: await prompter.text('  Index name', { default: 'trove' }),
      dimensions: await prompter.text('  Dimensions', { default: '1536', hint: 'must match your embedding model' }),
      metric: await prompter.choice('  Distance metric', [
        { value: 'cosine', label: 'cosine' },
        { value: 'euclidean', label: 'euclidean' },
        { value: 'dot-product', label: 'dot-product' },
      ], { default: 'cosine' }),
    };
  }

  w.ai = await prompter.confirm('\nBind Workers AI for natural-language search queries?', { default: false });
  w.tasks = await prompter.confirm('Bind the TroveTasks Durable Object for scans and reindexes?', { default: true });

  return w;
}
