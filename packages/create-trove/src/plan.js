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

import { generateVapidKeys } from './vapid.js';

export const RUNTIMES = ['bun', 'node', 'workers'];

// LocalHashEmbedding's dimension (see core/src/search/embeddings.js). Not a default
// anyone should be asked to confirm: with the built-in embedding this IS the number, and
// a Vectorize index created at any other size accepts the deploy and then rejects every
// vector write — so search returns nothing, forever, without a single error anywhere a
// user would look. The wizard knows which embedding was chosen, so it derives this
// rather than asking a question whose wrong answer is invisible.
export const BUILTIN_EMBEDDING_DIM = '256';

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
 * @param {() => Promise<{publicKey: string, privateKey: string}>} [opts.generateKeys]
 *   how a local VAPID pair is minted. Injected so this stays the pure, transcript-driven
 *   function it is elsewhere — a real key pair is random, and a test asserting on the
 *   plan cannot assert on randomness.
 * @returns {Promise<object>} the plan
 */
export async function askPlan(prompter, { name, version, runtime: preset, generateKeys = generateVapidKeys }) {
  const runtime = preset ?? await prompter.choice('Where will this run?', [
    { value: 'bun', label: 'Bun', hint: 'recommended for self-hosting' },
    { value: 'node', label: 'Node', hint: 'identical behaviour, a little slower' },
    { value: 'workers', label: 'Cloudflare Workers', hint: 'no disk — D1, Vectorize and R2 do the work' },
  ], { key: 'runtime', default: 'bun' });

  const isWorkers = runtime === 'workers';
  const plan = {
    name, version, runtime, sections: [], workers: null, server: null, skipped: [], warnings: [],
    // Overwritten only if an HTTP embedding names its own size.
    embeddingDim: BUILTIN_EMBEDDING_DIM,
  };

  const add = (title, entries, { skipped = false } = {}) => {
    plan.sections.push({ title, entries, skipped });
    if (skipped) plan.skipped.push(title);
  };

  // --- storage ---------------------------------------------------------------
  // Workers has no disk, so `filesystem` is not offered there — and R2 is reached
  // through the S3 API rather than a binding because that is what lets presigned
  // uploads go straight to the bucket instead of through the Worker's CPU time.
  if (await prompter.section('Object storage', { key: 'storage.enabled',
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
    ], { key: 'storage.driver', default: isWorkers ? 's3' : 'filesystem' });

    const entries = [entry('TROVE_STORAGE', driver)];
    if (driver === 'filesystem') {
      entries.push(entry('TROVE_FS_ROOT', await prompter.text('  Object root', { key: 'storage.root', default: './data/objects' }),
        { comment: 'the backend creates objects/ under this, sharded two levels deep' }));
    }
    if (driver === 's3') {
      entries.push(entry('TROVE_S3_BUCKET', await prompter.text('  Bucket', { key: 'storage.bucket', default: 'trove' })));
      entries.push(entry('TROVE_S3_REGION', await prompter.text('  Region', { key: 'storage.region', default: isWorkers ? 'auto' : 'us-east-1' }),
        { comment: 'R2 uses "auto"' }));
      entries.push(entry('TROVE_S3_ENDPOINT', await prompter.text('  Endpoint', { key: 'storage.endpoint',
        default: isWorkers ? 'https://<account-id>.r2.cloudflarestorage.com' : '',
        hint: 'leave blank for AWS S3',
      }), { comment: 'omit for AWS' }));
      entries.push(entry('TROVE_S3_ACCESS_KEY_ID', await prompter.text('  Access key id', { key: 'storage.accessKeyId', default: '' }), { secret: true }));
      entries.push(entry('TROVE_S3_SECRET_ACCESS_KEY', await prompter.text('  Secret access key', { key: 'storage.secretAccessKey', default: '' }), { secret: true }));
      if (!isWorkers && await prompter.confirm('  Path-style addressing?', { key: 'storage.pathStyle', default: false })) {
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
    if (await prompter.section('Metadata', { key: 'metadata.enabled', blurb: 'The file tree, collections, plugin installs and keyword index.' })) {
      const driver = await prompter.choice('  Store', [
        { value: 'sqlite', label: 'SQLite file', hint: 'one file, backed up with a VACUUM INTO snapshot' },
        { value: 'memory', label: 'In memory', hint: 'lost on restart' },
      ], { key: 'metadata.driver', default: 'sqlite' });
      const entries = [entry('TROVE_METADATA', driver)];
      if (driver === 'sqlite') {
        entries.push(entry('TROVE_DB_PATH', await prompter.text('  Database path', { key: 'metadata.path', default: './data/trove.db' })));
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
  if (await prompter.section('Semantic search', { key: 'search.enabled',
    blurb: 'Embeddings turn text into vectors; the vector store holds them. Both have working defaults.',
  })) {
    const entries = [];
    const embed = await prompter.choice('  Embeddings', [
      { value: 'builtin', label: 'Built-in hash embedding', hint: 'offline, no API key, weaker results' },
      { value: 'http', label: 'An HTTP embeddings API', hint: 'OpenAI-compatible' },
    ], { key: 'search.embeddings', default: 'builtin' });
    if (embed === 'http') {
      entries.push(entry('TROVE_EMBEDDINGS_URL', await prompter.text('  Embeddings URL', { key: 'search.embeddingsUrl', default: 'https://api.openai.com/v1/embeddings' })));
      entries.push(entry('TROVE_EMBEDDINGS_API_KEY', await prompter.text('  API key', { key: 'search.embeddingsApiKey', default: '' }), { secret: true }));
      entries.push(entry('TROVE_EMBEDDINGS_MODEL', await prompter.text('  Model', { key: 'search.embeddingsModel', default: 'text-embedding-3-small' })));
      plan.embeddingDim = await prompter.text('  Dimensions', { key: 'search.embeddingsDim', default: '1536' });
      entries.push(entry('TROVE_EMBEDDINGS_DIM', plan.embeddingDim,
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
      ], { key: 'search.vector', default: 'memory' });
      entries.push(entry('TROVE_VECTOR', vector));
      if (vector === 'qdrant') {
        entries.push(entry('TROVE_QDRANT_URL', await prompter.text('  Qdrant URL', { key: 'search.qdrantUrl', default: 'http://localhost:6333' })));
        entries.push(entry('TROVE_QDRANT_COLLECTION', await prompter.text('  Collection', { key: 'search.qdrantCollection', default: 'trove' })));
        entries.push(entry('TROVE_QDRANT_API_KEY', await prompter.text('  API key', { key: 'search.qdrantApiKey', default: '' }), { secret: true }));
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
  if (await prompter.section('Identity', { key: 'identity.enabled',
    blurb: 'Trove ships no login — it verifies what an IdP or proxy already established.',
  })) {
    const driver = await prompter.choice('  Verify identity via', [
      { value: 'cloudflare-access', label: 'Cloudflare Access / Zero Trust' },
      { value: 'jwt', label: 'A JWT from any OIDC provider', hint: 'verified against a JWKS' },
      { value: 'header', label: 'A header set by a verifying proxy' },
      { value: 'anonymous', label: 'Nobody', hint: 'everyone is the same anonymous user' },
    ], { key: 'identity.driver', default: isWorkers ? 'cloudflare-access' : 'anonymous' });

    const entries = [entry('TROVE_AUTH', driver)];
    if (driver === 'cloudflare-access') {
      entries.push(entry('TROVE_CF_ACCESS_TEAM', await prompter.text('  Access team name', { key: 'identity.team', default: '', hint: 'the <team> in <team>.cloudflareaccess.com' })));
      entries.push(entry('TROVE_CF_ACCESS_AUD', await prompter.text('  Application AUD tag', { key: 'identity.aud', default: '' })));
      // cloudflare-access is the one driver that requires auth unless told otherwise.
      entries.push(entry('TROVE_AUTH_REQUIRED', 'true', { comment: 'the default for this driver; "false" falls back to anonymous' }));
    } else if (driver === 'jwt') {
      entries.push(entry('TROVE_JWKS_URL', await prompter.text('  JWKS URL', { key: 'identity.jwksUrl', default: '' })));
      entries.push(entry('TROVE_JWT_ISSUER', await prompter.text('  Issuer', { key: 'identity.issuer', default: '' })));
      entries.push(entry('TROVE_JWT_AUDIENCE', await prompter.text('  Audience', { key: 'identity.audience', default: '' })));
      entries.push(entry('TROVE_AUTH_REQUIRED', String(await prompter.confirm('  Reject unauthenticated requests?', { key: 'identity.required', default: true }))));
    } else if (driver === 'header') {
      entries.push(entry('TROVE_AUTH_ID_HEADER', await prompter.text('  Identity header', { key: 'identity.header', default: 'cf-access-authenticated-user-email' }),
        { comment: 'only safe behind a proxy that sets this and strips it from client requests' }));
      entries.push(entry('TROVE_AUTH_REQUIRED', String(await prompter.confirm('  Reject unauthenticated requests?', { key: 'identity.required', default: true }))));
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
  if (await prompter.section('Access control', { key: 'access.enabled', blurb: 'Who is an admin, and whether the default collection is open to everyone.' })) {
    const admins = await prompter.text('  Admin principal ids', { key: 'access.admins', default: '', hint: 'comma-separated, usually email addresses' });
    const open = await prompter.confirm('  Give everyone full access to the default collection?', { key: 'access.defaultOpen', default: false });
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

  // --- notifications ---------------------------------------------------------
  // Off by default, and harmless to decline: mentions reach the in-app inbox either
  // way. What VAPID adds is the ping — a browser waking a service worker while the
  // drive is closed. The push carries no text (the worker fetches the inbox over its
  // own authenticated connection), so declining costs a banner and nothing else.
  if (await prompter.section('Push notifications', { key: 'notify.enabled',
    blurb: 'Web push when someone @mentions you. The in-app inbox works without it.',
    default: false,
  })) {
    // A LOCAL pair, minted here, written only to the gitignored .dev.vars. VAPID keys
    // are self-issued — no account, no network — so unlike an R2 credential there is
    // nothing to go and fetch, and making the developer find a way to produce a P-256
    // point before they can try the feature is friction with nothing on the other side
    // of it.
    //
    // Separate from production on purpose. A key identifies an application server, and
    // these are two different servers; keeping them apart also means the value sitting
    // on a laptop is worth nothing if it leaks.
    plan.devVapid = await generateKeys();

    // The production PUBLIC key only. The private half is never asked for: the answer
    // would be written to disk by a program whose whole job is writing files, and a
    // production signing key has no business in a scaffolder's output. It goes straight
    // from `npm run vapid` into `wrangler secret put`, and the step for that is emitted
    // whether or not this is filled in — see the blank-secret entry below.
    const publicKey = await prompter.text('  Production public key', { key: 'notify.publicKey', default: '',
      hint: 'leave blank — `npm run vapid` prints a pair once the project is installed',
    });
    add('Push notifications', [
      entry('TROVE_VAPID_PUBLIC_KEY', publicKey,
        { comment: 'must be the pair of the TROVE_VAPID_PRIVATE_KEY secret' }),
      entry('TROVE_VAPID_PRIVATE_KEY', '', { secret: true }),
      entry('TROVE_VAPID_SUBJECT', await prompter.text('  Contact subject', { key: 'notify.subject', default: 'mailto:admin@example.com',
        hint: 'mailto: or https URL — how a push service reaches you about your own traffic',
      })),
    ]);
  } else {
    add('Push notifications', [
      placeholder('TROVE_VAPID_PUBLIC_KEY', 'both keys set enables web push; the inbox works either way'),
      placeholder('TROVE_VAPID_PRIVATE_KEY', 'a credential — set it with `wrangler secret put`, not here'),
      placeholder('TROVE_VAPID_SUBJECT', 'mailto: or https URL; defaults to mailto:admin@example.com'),
    ], { skipped: true });
  }

  // --- branding --------------------------------------------------------------
  // The manifest is generated from configuration rather than served from a file, so
  // this is the one place a self-hoster gets to put their own name on the thing their
  // users install. Off by default: it is the only optional section here, and a drive
  // called "Trove" is a perfectly good drive.
  if (await prompter.section('Installed app name', { key: 'app.enabled',
    blurb: 'What the browser calls this when someone installs it. Defaults to Trove.',
    default: false,
  })) {
    const appName = await prompter.text('  App name', { key: 'app.name', default: 'Trove' });
    const entries = [entry('TROVE_APP_NAME', appName)];
    const short = await prompter.text('  Short name', { key: 'app.shortName', default: '', hint: 'for a home-screen label; defaults to the app name' });
    if (short) entries.push(entry('TROVE_APP_SHORT_NAME', short));
    entries.push(entry('TROVE_APP_THEME_COLOR', await prompter.text('  Theme colour', { key: 'app.themeColor', default: '#181a1f' })));
    const icon = await prompter.text('  Icon URL', { key: 'app.icon', default: '', hint: 'leave blank for the built-in mark' });
    if (icon) {
      entries.push(entry('TROVE_APP_ICON', icon));
      entries.push(entry('TROVE_APP_ICON_SIZES', await prompter.text('  Icon size', { key: 'app.iconSizes',
        default: icon.endsWith('.svg') ? 'any' : '512x512',
        hint: 'a raster icon claiming "any" gets scaled badly',
      })));
    }
    add('Installed app name', entries);
  } else {
    add('Installed app name', [
      placeholder('TROVE_APP_NAME', 'what the installed app is called; defaults to Trove'),
      placeholder('TROVE_APP_THEME_COLOR', 'defaults to #181a1f'),
      placeholder('TROVE_APP_ICON', 'defaults to the built-in mark'),
    ], { skipped: true });
  }

  // --- runtime specifics -----------------------------------------------------
  if (isWorkers) {
    plan.workers = await askWorkers(prompter, { embeddingDim: plan.embeddingDim });
  } else {
    plan.server = { port: '8787', host: '0.0.0.0' };
    if (await prompter.section('Server', { key: 'server.enabled', blurb: 'Port and bind address.', default: false })) {
      plan.server.port = await prompter.text('  Port', { key: 'server.port', default: '8787' });
      plan.server.host = await prompter.text('  Host', { key: 'server.host', default: '0.0.0.0' });
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
async function askWorkers(prompter, { embeddingDim }) {
  const w = {
    d1: null, pluginDb: null, vectorize: null, ai: false, tasks: true, workerLoader: false,
    // nodejs_compat v2 needs 2024-09-23 or later; that exact floor was also the hardcoded
    // value, which made it two years stale on the day it shipped.
    compatibilityDate: '2026-07-01',
  };

  if (await prompter.section('D1 (metadata)', { key: 'workers.d1.enabled',
    blurb: 'Bind DB or the drive runs entirely in memory — fine until the isolate recycles, then everything is gone.',
  })) {
    w.d1 = {
      name: await prompter.text('  Database name', { key: 'workers.d1.name', default: 'trove' }),
      id: await prompter.text('  Database id', { key: 'workers.d1.id', default: '', hint: 'from `wrangler d1 create` — leave blank to fill in after' }),
    };
    if (await prompter.confirm('  Bind a second D1 for server-side plugin storage?', { key: 'workers.pluginDb.enabled', default: false })) {
      w.pluginDb = {
        name: await prompter.text('  Plugin database name', { key: 'workers.pluginDb.name', default: 'trove-plugins' }),
        id: await prompter.text('  Plugin database id', { key: 'workers.pluginDb.id', default: '' }),
      };
    }
  }

  // Default FALSE, and the wording says why: running dynamic Workers on Cloudflare needs
  // the closed beta, so for most people the honest answer today is "not yet". Declaring
  // the binding without access makes the deploy fail, which is a worse first experience
  // than an install that refuses a plugin with a clear message.
  w.workerLoader = await prompter.confirm(
    '  Bind a Worker Loader so plugin indexers can run?',
    { key: 'workers.loader.enabled', default: false,
      hint: 'without it, plugin indexers are skipped — a plugin still installs and its '
        + 'viewers work, but nothing it would have contributed to search appears. '
        + 'Needs the Dynamic Workers closed beta; works in `wrangler dev` regardless' },
  );

  if (await prompter.section('Vectorize (semantic search)', { key: 'workers.vectorize.enabled',
    blurb: 'sqlite-vec is a native artifact and cannot load here, so semantic search needs Vectorize.',
  })) {
    w.vectorize = {
      index: await prompter.text('  Index name', { key: 'workers.vectorize.index', default: 'trove' }),
      // Derived, not asked. It has exactly one correct value — the dimension of the
      // embedding chosen above — and getting it wrong fails silently.
      dimensions: embeddingDim,
      metric: await prompter.choice('  Distance metric', [
        { value: 'cosine', label: 'cosine' },
        { value: 'euclidean', label: 'euclidean' },
        { value: 'dot-product', label: 'dot-product' },
      ], { key: 'workers.vectorize.metric', default: 'cosine' }),
    };
  }

  w.ai = await prompter.confirm('\nBind Workers AI for natural-language search queries?', { key: 'workers.ai', default: false });
  w.tasks = await prompter.confirm('Bind the TroveTasks Durable Object for scans and reindexes?', { key: 'workers.tasks', default: true });

  return w;
}
