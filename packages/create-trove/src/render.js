// Plan → files and commands.
//
// Pure: it takes the answers and returns `{ files, steps }`. Nothing is written here,
// which is what lets a test assert on a generated wrangler.toml without a temp
// directory, and what lets `--dry-run` be the same code path as a real run.
//
// The one rule worth stating out loud: a secret never becomes a file that belongs in
// version control. On Workers that means `[vars]` carries configuration and credentials
// become `wrangler secret put` steps plus a gitignored `.dev.vars` for local runs;
// everywhere else it means a gitignored `.env`. `secret: true` on an entry is the whole
// mechanism — there is no second list to keep in sync.

import { LOCAL_S3 } from './templates/localS3.js';
import { VAPID_SCRIPT } from './templates/vapid.js';
const RULE = '─'.repeat(58);

/** The exact version, not a range: the two packages are released together, and a drive
 *  whose server and workbench came from different releases is the failure this avoids. */
const pin = (version) => version;

const isSet = (e) => !e.commented && e.value !== '' && e.value != null;

/** The value of one env key across every section, or undefined. */
const valueOf = (sections, key) =>
  sections.flatMap((s) => s.entries).find((e) => e.key === key && isSet(e))?.value;

/** `cd` only when there is somewhere to go — scaffolding into `.` is already there. */
const enter = (plan) => (plan.inPlace ? '' : `cd ${plan.name} && `);

export function renderProject(plan) {
  const files = [];
  const steps = [];
  // Not `isSet`: leaving credentials blank is the common case at scaffold time — you
  // rarely have R2 keys yet — and that is precisely when you need to be told which
  // secrets the drivers you picked are going to want.
  const secrets = plan.sections.flatMap((s) => s.entries.filter((e) => e.secret));

  if (plan.runtime === 'workers') renderWorkers(plan, files, steps, secrets);
  else renderServer(plan, files, steps);

  files.push({ path: 'README.md', contents: readme(plan, steps) });
  return { files, steps };
}

// --- shared -----------------------------------------------------------------

/**
 * Render sections as a dotenv file.
 *
 * @param {object[]} sections
 * @param {object} [opts]
 * @param {boolean} [opts.secretsOnly] emit only the credentials — what .dev.vars wants
 * @param {boolean} [opts.omitSecrets] emit everything but the credentials
 */
function renderEnv(sections, { secretsOnly = false, omitSecrets = false } = {}) {
  const out = [];
  for (const section of sections) {
    const entries = section.entries.filter((e) => (secretsOnly ? e.secret : omitSecrets ? !e.secret : true));
    if (!entries.length) continue;
    out.push(`# ${RULE}`);
    out.push(`# ${section.title}${section.skipped ? '  (skipped — fill these in yourself)' : ''}`);
    out.push(`# ${RULE}`);
    for (const e of entries) {
      const comment = e.comment ? `   # ${e.comment}` : '';
      out.push(isSet(e) ? `${e.key}=${e.value}${comment}` : `# ${e.key}=${comment}`);
    }
    out.push('');
  }
  return out.join('\n');
}

const gitignore = (extra = []) => ['node_modules/', '.env', '.dev.vars', ...extra, ''].join('\n');

// --- bun / node --------------------------------------------------------------

function renderServer(plan, files, steps) {
  const { runtime, version, name, server } = plan;
  const exec = runtime === 'bun' ? 'bun' : 'node';
  const adapter = runtime === 'bun' ? 'bun.js' : 'node.js';

  // Bun reads .env on its own; Node needs telling, and --env-file is why this asks for
  // Node 20.6 rather than the 20 the server itself needs.
  const start = runtime === 'bun' ? 'bun server.js' : 'node --env-file=.env server.js';

  files.push({
    path: 'package.json',
    contents: JSON.stringify({
      name,
      private: true,
      type: 'module',
      scripts: { start },
      dependencies: { '@3sln/trove': pin(version) },
      engines: runtime === 'bun' ? { bun: '>=1.1.0' } : { node: '>=20.6' },
    }, null, 2) + '\n',
  });

  files.push({
    path: 'server.js',
    contents: `// Trove, as this project runs it.
//
// The adapter starts listening when it is imported — it reads its configuration from
// the environment (see .env), so there is nothing to pass it. Importing it through the
// package's public export rather than a path into node_modules means this line keeps
// working whatever the installer does with the tree.
//
// To add your own openers or views, this is the file that grows: build a workbench with
// \`createWorkbench({ openers, views })\` from '@3sln/trove/web/workbench.js', bundle it,
// and point TROVE_WEB_DIST at the result.
import '@3sln/trove/server/adapters/${adapter}';
`,
  });

  files.push({ path: '.env', contents: envHeader(plan) + renderEnv(plan.sections) + serverVars(server) });
  files.push({ path: '.gitignore', contents: gitignore(['data/']) });

  steps.push({ cmd: `${enter(plan)}npm install`, why: 'pulls @3sln/trove — the web app is already built inside it' });
  steps.push({ cmd: `npm start`, why: `serves the API and the workbench on :${server?.port ?? '8787'}` });
}

const serverVars = (server) => server
  ? [`# ${RULE}`, '# Server', `# ${RULE}`, `PORT=${server.port}`, `HOST=${server.host}`, ''].join('\n')
  : '';

const envHeader = (plan) => `# Generated by create-trove for a ${plan.runtime} deployment.
# Every value here is read at startup. Nothing in this file is committed — see .gitignore.

`;

// --- workers ------------------------------------------------------------------

function renderWorkers(plan, files, steps, secrets) {
  const { name, version, workers: w } = plan;

  // A local run needs somewhere for bytes to go, and there is no local R2. When the
  // drive is configured for S3 we ship a bucket that speaks the same API, because the
  // alternative — TROVE_STORAGE=memory — looks like it works and is a trap: memory
  // storage lives in ONE isolate while scans and reindexes run in the TroveTasks Durable
  // Object, which is another, so every item fails to index and search stays empty.
  const bucket = valueOf(plan.sections, 'TROVE_S3_BUCKET');
  const localS3 = valueOf(plan.sections, 'TROVE_STORAGE') === 's3' && bucket;
  // Push was configured if the section ran, whether or not a production key was pasted
  // in — the point of `npm run vapid` is that it usually was not.
  const push = plan.sections.some((sec) => sec.title === 'Push notifications' && !sec.skipped);

  files.push({
    path: 'package.json',
    contents: JSON.stringify({
      name,
      private: true,
      type: 'module',
      scripts: {
        dev: 'wrangler dev',
        ...(localS3 ? { 'dev:s3': 'node dev/local-s3.js' } : {}),
        ...(push ? { vapid: 'node dev/vapid.js' } : {}),
        deploy: 'wrangler deploy',
      },
      dependencies: { '@3sln/trove': pin(version) },
      devDependencies: { wrangler: '^4.0.0' },
    }, null, 2) + '\n',
  });

  if (localS3) {
    // The bucket name is baked in rather than passed through the environment, so the
    // script stays `node dev/local-s3.js` on every platform — `BUCKET=x node …` is not
    // a thing that runs on Windows.
    files.push({
      path: 'dev/local-s3.js',
      contents: LOCAL_S3.replace(
        "const BUCKET = process.env.BUCKET || 'trove';",
        `const BUCKET = process.env.BUCKET || ${JSON.stringify(bucket)};`,
      ),
    });
  }

  // Key rotation, and the way to produce the production pair in the first place. It
  // lives in the generated project rather than in the wizard because the wizard runs
  // through `npm create`, before this project has a node_modules — a scaffolder cannot
  // hand you a command that needs a package it has not installed yet.
  if (push) {
    files.push({ path: 'dev/vapid.js', contents: VAPID_SCRIPT });
  }

  files.push({
    path: 'src/worker.js',
    contents: `// The Worker entry.
//
// Both exports matter: the default export is the fetch handler, and TroveTasks is the
// Durable Object class that owns scans and reindexes. Wrangler looks the DO class up by
// name in this module, so re-exporting it here is what makes the binding resolve —
// declaring it in wrangler.toml without this is a deploy-time error.
export { default, TroveTasks } from '@3sln/trove/server/adapters/worker.js';
`,
  });

  files.push({ path: 'wrangler.toml', contents: wranglerToml(plan) });
  files.push({ path: '.gitignore', contents: gitignore(['.wrangler/']) });

  // `.dev.vars.example` rather than `.dev.vars`: the real file is gitignored, so
  // generating it produces something the next person on the project cannot see. The
  // example is committed and says what to copy it to.
  const devVars = devVarsExample(plan, { localS3, bucket });
  if (devVars) files.push({ path: '.dev.vars.example', contents: devVars });

  // And the real thing, gitignored, when there were answers worth keeping out of it.
  // Without this the credentials someone just typed would be discarded — the example
  // cannot hold them — and a local run against the real services would mean entering
  // them a second time.
  // A generated dev key counts: it is a value that exists nowhere else, so without
  // this the pair minted a moment ago would be described and then thrown away.
  const answered = secrets.some(isSet) || Boolean(plan.devVapid);
  if (devVars && answered) {
    files.push({
      path: '.dev.vars',
      contents: devVarsExample(plan, { localS3, bucket, withSecrets: true }),
    });
  }

  steps.push({ cmd: `${enter(plan)}npm install`, why: 'wrangler, and @3sln/trove for the app assets' });
  if (w?.d1) {
    steps.push({
      cmd: `npx wrangler d1 create ${w.d1.name}`,
      why: w.d1.id ? 'already have the id in wrangler.toml — skip if it exists' : 'then paste database_id into wrangler.toml',
    });
  }
  if (w?.pluginDb) {
    steps.push({ cmd: `npx wrangler d1 create ${w.pluginDb.name}`, why: 'server-side plugin storage' });
  }
  if (w?.vectorize) {
    steps.push({
      cmd: `npx wrangler vectorize create ${w.vectorize.index} --dimensions=${w.vectorize.dimensions} --metric=${w.vectorize.metric}`,
      why: 'semantic search — Vectorize is the only vector store that runs here',
    });
  }
  if (bucket) steps.push({ cmd: `npx wrangler r2 bucket create ${bucket}`, why: 'object bytes' });
  for (const s of secrets) {
    steps.push({
      cmd: `npx wrangler secret put ${s.key}`,
      why: isSet(s) ? 'in .dev.vars for local runs; set it here for the deployed Worker' : 'required by the drivers you chose',
    });
  }
  steps.push({ cmd: 'npx wrangler deploy', why: '' });
}

/**
 * The local-development overrides, as a committed example.
 *
 * `wrangler dev` reads `.dev.vars`, and values there beat `[vars]` in wrangler.toml.
 * That is the only lever a local run has, and it needs one: a scaffolded Workers drive
 * points at three things a laptop does not have. Without these overrides `npm run dev`
 * builds, boots, serves the web app — and then answers every API route with a 500,
 * which is a poor first five minutes and reads as a broken scaffold rather than a
 * missing account.
 *
 * Each block is emitted only when the configuration actually needs it, so nobody is
 * handed an override for a service they did not choose.
 */
function devVarsExample(plan, { localS3, bucket, withSecrets = false }) {
  const { sections, workers: w } = plan;
  const L = [];
  const supplied = (key) => valueOf(sections, key);
  const rule = (title) => {
    L.push(`# ${RULE}`, `# ${title}`, `# ${RULE}`);
  };

  const auth = valueOf(sections, 'TROVE_AUTH');
  const needsIdentityOverride = auth && auth !== 'anonymous';
  const secrets = sections.flatMap((s) => s.entries.filter((e) => e.secret));
  if (!needsIdentityOverride && !localS3 && !w?.vectorize && !plan.devVapid && !secrets.length) return null;

  L.push(withSecrets
    ? '# Local settings for `wrangler dev`. Gitignored, and NOT uploaded by `wrangler deploy` —'
    : '# Copy to .dev.vars (gitignored) for `wrangler dev`. NOT uploaded by `wrangler deploy` —');
  L.push('# the deployed Worker reads its credentials from secrets; see README.md for the commands.');
  L.push('#');
  L.push('# Values here OVERRIDE [vars] in wrangler.toml for local runs. That is what lets a');
  L.push('# local drive work without a Cloudflare account: there is no local R2, no local');
  L.push('# Vectorize, and nothing in front of `wrangler dev` to authenticate anyone.');
  L.push('');

  if (needsIdentityOverride) {
    rule('Identity — local only');
    L.push(`# TROVE_AUTH is "${auth}" in wrangler.toml, which verifies a token nothing issues`);
    L.push('# locally — every request would be rejected. Locally you are one anonymous user,');
    L.push('# and an admin, so the workbench is actually usable.');
    L.push('TROVE_AUTH=anonymous');
    L.push('TROVE_AUTH_REQUIRED=false');
    L.push('TROVE_ADMINS=anonymous');
    L.push('');
  }

  if (localS3) {
    rule('Object storage — local only');
    L.push('# `npm run dev:s3` serves a bucket on :9000 over the same S3 API R2 speaks, so a');
    L.push('# local run exercises the real path: SigV4, presigned PUTs, multipart, ranges.');
    L.push('#');
    L.push('# Do NOT replace this with TROVE_STORAGE=memory. Memory storage lives in one');
    L.push('# isolate, and scans and reindexes run in the TroveTasks Durable Object, which is');
    L.push('# another — every item fails to index with "Object not found" and search quietly');
    L.push('# returns nothing.');
    L.push(`TROVE_S3_BUCKET=${bucket}`);
    L.push('TROVE_S3_ENDPOINT=http://127.0.0.1:9000');
    L.push('# Virtual-host style would need a subdomain of localhost to resolve, which is not');
    L.push('# dependable; path style keeps it on 127.0.0.1.');
    L.push('TROVE_S3_PATH_STYLE=true');
    L.push('# dev/local-s3.js does not verify signatures. These only have to be non-empty so');
    L.push('# the SigV4 signer has something to sign with.');
    // Real credentials, when they were supplied, but only into the gitignored file. The
    // committed example gets the throwaway pair — see below.
    const id = (withSecrets && supplied('TROVE_S3_ACCESS_KEY_ID')) || 'local';
    const key = (withSecrets && supplied('TROVE_S3_SECRET_ACCESS_KEY')) || 'local-secret';
    L.push(`TROVE_S3_ACCESS_KEY_ID=${id}`);
    L.push(`TROVE_S3_SECRET_ACCESS_KEY=${key}`);
    L.push('');
  }

  if (plan.devVapid) {
    rule('Push notifications — local only');
    L.push('# A local key pair, generated when this project was scaffolded. Production uses');
    L.push('# a different one: a VAPID key identifies an application server, and these are');
    L.push('# two servers — so this value leaking costs nothing, and a browser that');
    L.push('# subscribed to your laptop is not subscribed to production.');
    L.push('#');
    L.push('# Only in .dev.vars, never in the committed example: it is still a private key,');
    L.push('# and one shared by every clone of the repo is one nobody can reason about.');
    L.push('# `npm run vapid` mints another.');
    if (withSecrets) {
      L.push(`TROVE_VAPID_PUBLIC_KEY=${plan.devVapid.publicKey}`);
      L.push(`TROVE_VAPID_PRIVATE_KEY=${plan.devVapid.privateKey}`);
    } else {
      L.push('# TROVE_VAPID_PUBLIC_KEY=    # run `npm run vapid` and paste the pair here');
      L.push('# TROVE_VAPID_PRIVATE_KEY=');
    }
    L.push('');
  }

  if (w?.vectorize) {
    rule('Semantic search — local only');
    L.push('# Vectorize has no local emulation: every call fails with "Binding VECTORIZE needs');
    L.push('# to be run remotely". An explicit TROVE_VECTOR beats the binding, so this swaps in');
    L.push('# the in-process store — the same code path a drive with no Vectorize would take.');
    L.push('# To exercise the real index instead, log in and add `remote = true` to [[vectorize]].');
    L.push('TROVE_VECTOR=memory');
    L.push('');
  }

  // Whatever a local block already set is NOT repeated below. Listing a key twice in one
  // dotenv file is a trap: the commented copy reads like the place to put your real
  // credential, and uncommenting it silently points local runs at a bucket that is not
  // the one `npm run dev:s3` is serving.
  const overridden = new Set([
    ...(localS3 ? ['TROVE_S3_ACCESS_KEY_ID', 'TROVE_S3_SECRET_ACCESS_KEY'] : []),
    // The local pair above already set this one. Repeating it, commented, reads as the
    // place to paste the PRODUCTION key — which is a value this file should never hold
    // and which the wizard deliberately never asks for.
    ...(plan.devVapid ? ['TROVE_VAPID_PRIVATE_KEY'] : []),
  ]);
  const remaining = secrets.filter((e) => !overridden.has(e.key));
  if (remaining.length) {
    rule('Credentials');
    L.push('# Only needed for a local run that talks to the real service. The deployed Worker');
    L.push('# reads these from secrets, not from this file — leaving them blank is fine.');
    for (const e of remaining) {
      // A value only ever reaches the gitignored file. `.dev.vars.example` is committed,
      // so it carries the KEY and nothing else — writing an answered credential into it
      // would put the secret in version control, which is the one rule this whole module
      // is built around.
      const value = withSecrets && isSet(e) ? e.value : '';
      const comment = e.comment ? `   # ${e.comment}` : '';
      L.push(value ? `${e.key}=${value}${comment}` : `# ${e.key}=${comment}`);
    }
    L.push('');
  }

  return L.join('\n');
}

function wranglerToml(plan) {
  const { workers: w, sections } = plan;
  const q = (v) => JSON.stringify(String(v));
  const L = [];

  L.push('# Generated by create-trove. Every binding below has a matching command in README.md —');
  L.push('# a wrangler.toml naming a D1 database nobody created deploys fine and fails at request time.');
  L.push('');
  L.push('name = ' + q(plan.name));
  L.push('main = "src/worker.js"');
  L.push(`compatibility_date = ${q(w?.compatibilityDate ?? '2026-07-01')}`);
  L.push('');
  L.push('# core/index.js re-exports FilesystemStorage, which imports node:fs, node:path and');
  L.push('# node:stream at the top level — so they are in the bundle whether or not a Workers');
  L.push('# deployment could ever use that backend. Without this the build does not link.');
  L.push('compatibility_flags = ["nodejs_compat"]');
  L.push('');

  L.push('# The built web app, served straight from the installed package — no build step');
  L.push('# here, because @3sln/trove ships its dist/ inside the tarball.');
  L.push('[assets]');
  L.push('directory = "node_modules/@3sln/trove/packages/web/dist"');
  L.push('binding = "ASSETS"');
  L.push('');

  if (w?.d1) {
    L.push('# Metadata, KV, plugin installs and keyword search. Without this the drive runs');
    L.push('# entirely in memory and loses everything when the isolate recycles.');
    L.push('[[d1_databases]]');
    L.push('binding = "DB"');
    L.push(`database_name = ${q(w.d1.name)}`);
    L.push(`database_id = ${q(w.d1.id || '<run: wrangler d1 create ' + w.d1.name + '>')}`);
    L.push('');
  } else {
    L.push('# [[d1_databases]]          # REQUIRED for anything to persist');
    L.push('# binding = "DB"');
    L.push('# database_name = "trove"');
    L.push('# database_id = "<wrangler d1 create trove>"');
    L.push('');
  }

  if (w?.pluginDb) {
    L.push('# Server-side plugin storage. One database holds every plugin scope: D1 cannot');
    L.push('# create databases on demand, so per-scope databases are not expressible here.');
    L.push('[[d1_databases]]');
    L.push('binding = "PLUGIN_DB"');
    L.push(`database_name = ${q(w.pluginDb.name)}`);
    L.push(`database_id = ${q(w.pluginDb.id || '<run: wrangler d1 create ' + w.pluginDb.name + '>')}`);
    L.push('');
  } else {
    L.push('# [[d1_databases]]          # optional: server-side plugin storage');
    L.push('# binding = "PLUGIN_DB"     # without it that one feature reports a clear error');
    L.push('');
  }

  if (w?.vectorize) {
    L.push('[[vectorize]]');
    L.push('binding = "VECTORIZE"');
    L.push(`index_name = ${q(w.vectorize.index)}`);
    L.push('');
  } else {
    L.push('# [[vectorize]]             # semantic search; sqlite-vec cannot load on Workers');
    L.push('# binding = "VECTORIZE"');
    L.push('# index_name = "trove"');
    L.push('');
  }

  if (w?.ai) {
    L.push('# Turns natural language into semantic text + tag filters; falls back to the');
    L.push('# #tag grammar on error.');
    L.push('[ai]');
    L.push('binding = "AI"');
    L.push('');
  } else {
    L.push('# [ai]                      # optional: LLM query understanding');
    L.push('# binding = "AI"');
    L.push('');
  }

  if (w?.tasks) {
    L.push('# Scans and reindexes live in one Durable Object, so a client polling /api/tasks');
    L.push('# reaches the isolate that actually holds the task and Cancel reaches its');
    L.push('# AbortController. Without it the work still runs, in the request isolate.');
    L.push('[[durable_objects.bindings]]');
    L.push('name = "TASKS"');
    L.push('class_name = "TroveTasks"');
    L.push('');
    L.push('[[migrations]]');
    L.push('tag = "v1"');
    L.push('new_sqlite_classes = ["TroveTasks"]');
    L.push('');
  } else {
    L.push('# [[durable_objects.bindings]]   # optional: owns scans and reindexes');
    L.push('# name = "TASKS"');
    L.push('# class_name = "TroveTasks"');
    L.push('# [[migrations]]');
    L.push('# tag = "v1"');
    L.push('# new_sqlite_classes = ["TroveTasks"]');
    L.push('');
  }

  L.push('# Maintenance. A timer registered inside a request does not outlive the request, so');
  L.push('# on Workers there is no periodic work at all without a cron: expired uploads are');
  L.push('# never swept, trash retention never applies, and collection scans never advance.');
  L.push('# Each firing runs one time-boxed slice (TROVE_CRON_BUDGET_MS, default 20s).');
  L.push('[triggers]');
  L.push('crons = ["*/5 * * * *"]');
  L.push('');
  L.push('[vars]');
  L.push('# Configuration only. Credentials are secrets — see README.md.');
  for (const section of sections) {
    const shown = section.entries.filter((e) => !e.secret);
    if (!shown.length) continue;
    L.push(`# ${section.title}${section.skipped ? '  (skipped)' : ''}`);
    for (const e of shown) {
      const c = e.comment ? `  # ${e.comment}` : '';
      L.push(isSet(e) ? `${e.key} = ${q(e.value)}${c}` : `# ${e.key} = ""${c}`);
    }
  }
  L.push('');
  return L.join('\n');
}

// --- the generated README -----------------------------------------------------

function readme(plan, steps) {
  const L = [];
  const runtimeName = { bun: 'Bun', node: 'Node', workers: 'Cloudflare Workers' }[plan.runtime];

  L.push(`# ${plan.name}`);
  L.push('');
  L.push(`A [Trove](https://github.com/3sln/trove) drive on **${runtimeName}**, scaffolded with \`create-trove\`.`);
  L.push('');
  L.push(`The web app is not built here — \`@3sln/trove@${plan.version}\` ships it already built, so the`);
  L.push('server and the workbench it serves are the same release by construction.');
  L.push('');

  L.push('## Getting it running');
  L.push('');
  L.push('```sh');
  for (const s of steps) L.push(s.why ? `${s.cmd}${' '.repeat(Math.max(1, 44 - s.cmd.length))}# ${s.why}` : s.cmd);
  L.push('```');
  L.push('');

  if (plan.runtime === 'workers') {
    const localS3 = plan.sections.flatMap((s) => s.entries)
      .some((e) => e.key === 'TROVE_STORAGE' && e.value === 's3' && !e.commented);

    // A generated `.dev.vars` holds the credentials that were just answered; telling
    // someone to copy the example over it would throw them away on the first read of
    // this file.
    const hasDevVars = plan.sections.flatMap((s) => s.entries).some((e) => e.secret && isSet(e));

    L.push('## Local development');
    L.push('');
    L.push('None of the account setup above is needed to run this locally.');
    L.push('');
    L.push('```sh');
    if (hasDevVars) L.push('# .dev.vars is already written, with the credentials you gave — it is gitignored');
    else L.push('cp .dev.vars.example .dev.vars   # local identity, storage and search');
    if (localS3) L.push('npm run dev:s3                  # terminal 1 — a local S3 bucket on :9000');
    L.push(`npm run dev                     # terminal ${localS3 ? '2' : '1'} — the Worker on :8787`);
    L.push('```');
    L.push('');
    L.push('`.dev.vars` overrides `[vars]` for local runs only and is never uploaded by');
    L.push('`wrangler deploy`. Without it the Worker builds and serves the web app, then answers');
    L.push('every API route with a 500 — it is pointed at services a laptop does not have.');
    L.push('');
    L.push('What a local run does **not** cover:');
    L.push('');
    L.push('- **Vectorize** has no local emulation, so `.dev.vars` swaps in the in-process vector');
    L.push('  store. Same search code, different index. Add `remote = true` to `[[vectorize]]` to');
    L.push('  use the real one.');
    L.push('- **Authorisation.** Locally you are one anonymous admin, so nothing exercises the');
    L.push('  identity driver or the collection grants.');
    if (localS3) {
      L.push('- **`dev/local-s3.js` does not verify signatures** and keeps objects in memory. It is');
      L.push('  a development bucket, bound to 127.0.0.1, and nothing more.');
    }
    L.push('');
  }

  if (plan.warnings.length) {
    const kind = (w) => (typeof w === 'string' ? w : w.kind);
    const has = (k) => plan.warnings.some((w) => kind(w) === k);
    const found = (k) => plan.warnings.find((w) => kind(w) === k);

    L.push('## Before you expose this');
    L.push('');
    if (has('anonymous')) {
      L.push('- **No identity is configured.** Everyone who can reach the port is the same');
      L.push('  anonymous user. Set `TROVE_AUTH` and `TROVE_AUTH_REQUIRED=true`, and put it behind');
      L.push('  an authenticating proxy over TLS.');
    }
    if (has('incomplete-identity')) {
      const w = found('incomplete-identity');
      L.push(`- **\`TROVE_AUTH=${w.driver}\` is set but incomplete** — ${w.missing.join(', ')} ${w.missing.length > 1 ? 'are' : 'is'} blank.`);
      L.push('  The config reads as configured while the driver has nothing to verify against.');
    }
    if (has('default-open')) {
      L.push('- **The default collection is open.** Every authenticated user gets full');
      L.push('  read/write/delete on it. Set `TROVE_DEFAULT_OPEN=false`.');
    }
    L.push('');
  }

  if (plan.skipped.length) {
    L.push('## Skipped');
    L.push('');
    L.push('Left for you to fill in. The keys are already in place, commented, in');
    L.push(plan.runtime === 'workers' ? '`wrangler.toml`:' : '`.env`:');
    L.push('');
    for (const s of plan.skipped) L.push(`- ${s}`);
    L.push('');
  }

  L.push('## Configuration');
  L.push('');
  L.push(plan.runtime === 'workers'
    ? 'Non-secret settings live in `[vars]` in `wrangler.toml`; credentials are secrets, set with\n`wrangler secret put`, and mirrored into a gitignored `.dev.vars` for `wrangler dev`.'
    : 'Everything is in `.env`, which is gitignored. The full set of variables, with defaults,\nis documented in the Trove README.');
  L.push('');
  return L.join('\n');
}
