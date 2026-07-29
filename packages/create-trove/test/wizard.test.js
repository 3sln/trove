// The wizard, driven from transcripts.
//
// `askPlan` and `renderProject` are both pure, so every one of these runs the real
// question flow and the real file generation without a terminal or a temp directory.
// The scripted prompter matches answers to prompts by label, so a question inserted in
// the middle fails loudly here instead of silently shifting every later answer onto the
// wrong prompt.

import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { scripted } from '../src/prompt.js';
import { askPlan } from '../src/plan.js';
import { renderProject } from '../src/render.js';

const VERSION = '9.9.9';
const fileNamed = (files, p) => files.find((f) => f.path === p);

// A fixed pair, so a test can assert on the key that was minted. The real generator is
// random by definition, which is exactly what a transcript-driven test cannot hold.
const FAKE_KEYS = { publicKey: 'dev-public-half', privateKey: 'dev-private-half' };

async function plan(script, runtime, opts = {}) {
  const p = scripted(script);
  const result = await askPlan(p, {
    name: 'my-drive', version: VERSION, runtime, generateKeys: async () => FAKE_KEYS, ...opts,
  });
  return { plan: result, ...renderProject(result), unanswered: p.unanswered() };
}

// --- the coupling both packages exist to keep -------------------------------

test('create-trove and trove carry the same version', () => {
  // Released together from one repository, so the scaffolder can pin the exact version
  // it was built alongside without looking anything up. If these ever drift, a
  // scaffolded project pairs a server with a workbench from a different release — the
  // whole failure mode that shipping one package was meant to end.
  //
  // `npm version` keeps them together on its own (the `version` lifecycle script runs
  // scripts/sync-version.mjs and stages the result), so this is here for the hand-edit
  // — which is exactly the case where nothing else would notice.
  const here = path.resolve(import.meta.dir, '..');
  const mine = JSON.parse(readFileSync(path.join(here, 'package.json'), 'utf8'));
  const trove = JSON.parse(readFileSync(path.resolve(here, '../../package.json'), 'utf8'));
  expect(mine.name).toBe('@3sln/create-trove');
  expect(trove.name).toBe('@3sln/trove');
  if (mine.version !== trove.version) {
    throw new Error(
      `@3sln/create-trove is ${mine.version} but @3sln/trove is ${trove.version}.\n`
      + 'They are released together and the scaffolder pins the drive by its own version.\n'
      + 'Fix it with:  npm run sync-version',
    );
  }
});

test('the pin is exact, not a range', async () => {
  const { files } = await plan([['Where will this run?', 'bun'], ['Object storage', false],
    ['Metadata', false], ['Semantic search', false], ['Identity', false], ['Access control', false], ['Server', false]]);
  const pkg = JSON.parse(fileNamed(files, 'package.json').contents);
  // A caret here would let `npm install` pair the scaffolded project with a newer
  // server than the workbench it was generated against.
  expect(pkg.dependencies['@3sln/trove']).toBe(VERSION);
});

// --- bun / node ---------------------------------------------------------------

test('a bun project starts the bun adapter through the public export', async () => {
  const { files } = await plan([
    ['Where will this run?', 'bun'],
    ['Object storage', true], ['  Backend', 'filesystem'], ['  Object root', './data/objects'],
    ['Metadata', true], ['  Store', 'sqlite'], ['  Database path', './data/trove.db'],
    ['Semantic search', false], ['Identity', false], ['Access control', false], ['Server', false],
  ]);
  expect(fileNamed(files, 'server.js').contents).toContain("import '@3sln/trove/server/adapters/bun.js'");
  expect(JSON.parse(fileNamed(files, 'package.json').contents).scripts.start).toBe('bun server.js');

  const env = fileNamed(files, '.env').contents;
  expect(env).toContain('TROVE_STORAGE=filesystem');
  expect(env).toContain('TROVE_FS_ROOT=./data/objects');
  expect(env).toContain('TROVE_DB_PATH=./data/trove.db');
  // .env is never committed, so the credentials that live in it need somewhere to go.
  expect(fileNamed(files, '.gitignore').contents).toContain('.env');
});

test('a node project loads .env itself, because node does not', async () => {
  const { files } = await plan([
    ['Where will this run?', 'node'],
    ['Object storage', false], ['Metadata', false], ['Semantic search', false],
    ['Identity', false], ['Access control', false], ['Server', false],
  ]);
  // Bun reads .env on its own; node needs --env-file, and a project whose start script
  // forgets it comes up with every setting at its default and no error.
  expect(JSON.parse(fileNamed(files, 'package.json').contents).scripts.start).toBe('node --env-file=.env server.js');
  expect(fileNamed(files, 'server.js').contents).toContain('adapters/node.js');
});

// --- workers -------------------------------------------------------------------

const WORKERS_SCRIPT = [
  ['Object storage', true], ['  Backend', 's3'], ['  Bucket', 'trove-objects'],
  ['  Region', 'auto'], ['  Endpoint', 'https://acct.r2.cloudflarestorage.com'],
  ['  Access key id', 'AKIAEXAMPLE'], ['  Secret access key', 'sekrit'],
  ['Semantic search', true], ['  Embeddings', 'builtin'],
  ['Identity', true], ['  Verify identity via', 'cloudflare-access'],
  ['  Access team name', 'acme'], ['  Application AUD tag', 'aud-tag'],
  ['Access control', true], ['  Admin principal ids', 'you@example.com'],
  ['  Give everyone full access', false],
  ['D1 (metadata)', true], ['  Database name', 'trove'], ['  Database id', 'db-123'],
  ['  Bind a second D1', false],
  ['Vectorize (semantic search)', true], ['  Index name', 'trove'],
  ['  Distance metric', 'cosine'],
  ['Bind Workers AI', true], ['Bind the TroveTasks', true],
];

test('a workers project binds what it was told to bind', async () => {
  const { files, unanswered } = await plan([...WORKERS_SCRIPT], 'workers');
  expect(unanswered).toEqual([]);
  const toml = fileNamed(files, 'wrangler.toml').contents;

  expect(toml).toContain('binding = "DB"');
  expect(toml).toContain('database_id = "db-123"');
  expect(toml).toContain('binding = "VECTORIZE"');
  expect(toml).toContain('index_name = "trove"');
  expect(toml).toContain('[ai]');
  expect(toml).toContain('class_name = "TroveTasks"');
  expect(toml).toContain('new_sqlite_classes = ["TroveTasks"]');

  // The built app is served out of the installed package — the reason there is no build
  // step in a scaffolded project at all.
  expect(toml).toContain('directory = "node_modules/@3sln/trove/packages/web/dist"');

  // Both exports, or the DO class does not resolve and the deploy fails.
  expect(fileNamed(files, 'src/worker.js').contents)
    .toContain("export { default, TroveTasks } from '@3sln/trove/server/adapters/worker.js'");
});

test('credentials never reach wrangler.toml', async () => {
  const { files, steps } = await plan([...WORKERS_SCRIPT], 'workers');
  const toml = fileNamed(files, 'wrangler.toml').contents;

  // wrangler.toml is committed. A secret in [vars] is a secret in git history.
  expect(toml).not.toContain('sekrit');
  expect(toml).not.toContain('AKIAEXAMPLE');
  expect(toml).toContain('TROVE_S3_BUCKET = "trove-objects"');   // configuration still lands

  // They become commands instead, and a gitignored file for `wrangler dev`.
  const cmds = steps.map((s) => s.cmd);
  expect(cmds).toContain('npx wrangler secret put TROVE_S3_ACCESS_KEY_ID');
  expect(cmds).toContain('npx wrangler secret put TROVE_S3_SECRET_ACCESS_KEY');
  // The answered credential goes to the GITIGNORED file, and only there. `.gitignore`
  // covers `.dev.vars` but not `.dev.vars.example`, so a value written into the example
  // is a value committed — the same failure this test is named for, one file over.
  expect(fileNamed(files, '.dev.vars').contents).toContain('TROVE_S3_SECRET_ACCESS_KEY=sekrit');
  expect(fileNamed(files, '.dev.vars.example').contents).not.toContain('sekrit');
  expect(fileNamed(files, '.dev.vars.example').contents).toContain('TROVE_S3_SECRET_ACCESS_KEY');
  expect(fileNamed(files, '.gitignore').contents).toContain('.dev.vars');
});

test('the committed example never carries a value, even when one was given', async () => {
  const { files } = await plan([...WORKERS_SCRIPT], 'workers');
  const example = fileNamed(files, '.dev.vars.example').contents;
  // Every line that assigns something is either a local-development override or a
  // throwaway for the local bucket. Nothing here came from an answer.
  const assigned = example.split('\n').filter((l) => /^[A-Z][A-Z0-9_]*=/.test(l));
  expect(assigned.length).toBeGreaterThan(0);
  for (const line of assigned) {
    expect(line).not.toContain('sekrit');
    expect(line).not.toContain('AKIAEXAMPLE');
  }
});

test('every resource named in the config also has a command to create it', async () => {
  const { steps } = await plan([...WORKERS_SCRIPT], 'workers');
  const cmds = steps.map((s) => s.cmd);
  // The most common way a first Workers deploy fails is a binding pointing at something
  // that was never created — which deploys fine and breaks at request time.
  expect(cmds).toContain('npx wrangler d1 create trove');
  // 256, not 1536: the built-in embedding was chosen, and an index of any other size
  // accepts the deploy then rejects every write. See BUILTIN_EMBEDDING_DIM.
  expect(cmds).toContain('npx wrangler vectorize create trove --dimensions=256 --metric=cosine');
  expect(cmds).toContain('npx wrangler r2 bucket create trove-objects');
  expect(cmds.at(-1)).toBe('npx wrangler deploy');
});

test('a host can put its own name on the installed app', async () => {
  const { files } = await plan([
    ['Where will this run?', 'bun'],
    ['Object storage', false], ['Metadata', false], ['Semantic search', false],
    ['Identity', false], ['Access control', false],
    ['Installed app name', true], ['  App name', 'Acme Files'], ['  Short name', 'Files'],
    ['  Theme colour', '#0b5cff'], ['  Icon URL', '/brand/logo.png'], ['  Icon size', '512x512'],
    ['Server', false],
  ]);
  const env = fileNamed(files, '.env').contents;
  expect(env).toContain('TROVE_APP_NAME=Acme Files');
  expect(env).toContain('TROVE_APP_SHORT_NAME=Files');
  expect(env).toContain('TROVE_APP_THEME_COLOR=#0b5cff');
  expect(env).toContain('TROVE_APP_ICON=/brand/logo.png');
  // A raster icon has to say its real size — "any" is a claim the browser believes.
  expect(env).toContain('TROVE_APP_ICON_SIZES=512x512');
});

test('branding is off unless asked for, and a blank short name is not written', async () => {
  const { plan: p, files } = await plan([
    ['Where will this run?', 'node'],
    ['Object storage', false], ['Metadata', false], ['Semantic search', false],
    ['Identity', false], ['Access control', false],
    ['Installed app name', true], ['  App name', 'Acme Files'], ['  Short name', ''],
    ['  Theme colour', '#181a1f'], ['  Icon URL', ''],
    ['Server', false],
  ]);
  const env = fileNamed(files, '.env').contents;
  // Unset rather than empty: the server falls back to the app name, and an empty
  // string would override that with nothing.
  expect(env).not.toContain('TROVE_APP_SHORT_NAME=');
  expect(env).not.toContain('TROVE_APP_ICON=');
  expect(p.skipped).not.toContain('Installed app name');
});

// --- skipping -------------------------------------------------------------------

test('a skipped section still documents itself, commented', async () => {
  const { plan: p, files } = await plan([
    ['Where will this run?', 'bun'],
    ['Object storage', false], ['Metadata', false], ['Semantic search', false],
    ['Identity', false], ['Access control', false], ['Server', false],
  ]);
  const env = fileNamed(files, '.env').contents;

  expect(p.skipped).toContain('Object storage');
  // Commented, not absent: someone who declined the interview still needs to know which
  // keys exist and what they are for.
  expect(env).toContain('# TROVE_STORAGE=');
  expect(env).toContain('# TROVE_DB_PATH=');
  expect(env).not.toContain('\nTROVE_STORAGE=');
  expect(fileNamed(files, 'README.md').contents).toContain('## Skipped');
});

test('skipping identity is called out as a security decision, not a blank', async () => {
  const { plan: p, files } = await plan([
    ['Where will this run?', 'node'],
    ['Object storage', false], ['Metadata', false], ['Semantic search', false],
    ['Identity', false], ['Access control', false], ['Server', false],
  ]);
  expect(p.warnings).toContain('anonymous');
  expect(p.warnings).toContain('default-open');
  const readme = fileNamed(files, 'README.md').contents;
  expect(readme).toContain('Before you expose this');
  expect(readme).toContain('No identity is configured');
});

test('a driver named but not filled in is flagged, because the config looks configured', async () => {
  const { plan: p, files } = await plan([
    ['Object storage', false], ['Semantic search', false],
    ['Identity', true], ['  Verify identity via', 'cloudflare-access'],
    ['  Access team name', ''], ['  Application AUD tag', ''],
    ['Access control', false],
    ['D1 (metadata)', false], ['Vectorize (semantic search)', false],
    ['Bind Workers AI', false], ['Bind the TroveTasks', false],
  ], 'workers');

  const w = p.warnings.find((x) => x.kind === 'incomplete-identity');
  expect(w.driver).toBe('cloudflare-access');
  expect(w.missing).toEqual(['TROVE_CF_ACCESS_TEAM', 'TROVE_CF_ACCESS_AUD']);
  expect(fileNamed(files, 'README.md').contents).toContain('is set but incomplete');
  // Not the anonymous warning — this is the opposite failure, a driver that will
  // refuse every request rather than accept every request.
  expect(p.warnings.some((x) => x === 'anonymous')).toBe(false);
});

test('choosing anonymous explicitly warns just the same', async () => {
  const { plan: p } = await plan([
    ['Where will this run?', 'bun'],
    ['Object storage', false], ['Metadata', false], ['Semantic search', false],
    ['Identity', true], ['  Verify identity via', 'anonymous'],
    ['Access control', false], ['Server', false],
  ]);
  expect(p.warnings).toContain('anonymous');
});

// --- what the Workers template has to get right ---------------------------------

test('the Vectorize index is sized to the embedding, not to a guess', async () => {
  // The failure this prevents is silent. A 1536 index built for the 256-dimension
  // built-in embedding deploys clean and then rejects every vector write, so search
  // returns nothing and nothing anywhere says why. It was a question with a default;
  // there is exactly one correct answer, so it is derived.
  const builtin = await plan([...WORKERS_SCRIPT], 'workers');
  expect(builtin.plan.workers.vectorize.dimensions).toBe('256');
  expect(builtin.steps.map((s) => s.cmd))
    .toContain('npx wrangler vectorize create trove --dimensions=256 --metric=cosine');

  // With an HTTP embedding the two cannot disagree either: the index takes the size the
  // model was told to produce.
  const http = await plan([
    ...WORKERS_SCRIPT.filter(([m]) => m !== '  Embeddings'),
    ['  Embeddings', 'http'], ['  Embeddings URL', 'https://api.openai.com/v1/embeddings'],
    ['  API key', 'k'], ['  Model', 'text-embedding-3-large'], ['  Dimensions', '3072'],
  ], 'workers');
  expect(http.plan.workers.vectorize.dimensions).toBe('3072');
  expect(http.steps.map((s) => s.cmd)).toContain('npx wrangler vectorize create trove --dimensions=3072 --metric=cosine');
});

test('a cron is emitted, because nothing periodic runs on Workers without one', async () => {
  // setInterval does not outlive the request that registered it, so with no cron the
  // upload sweep, trash retention and collection scans never run at all.
  const { files } = await plan([...WORKERS_SCRIPT], 'workers');
  const toml = fileNamed(files, 'wrangler.toml').contents;
  expect(toml).toContain('[triggers]');
  expect(toml).toContain('crons = ["*/5 * * * *"]');
});

test('the build is given what it needs to link', async () => {
  const { files } = await plan([...WORKERS_SCRIPT], 'workers');
  const toml = fileNamed(files, 'wrangler.toml').contents;
  // core/index.js re-exports FilesystemStorage, which imports node:fs at the top level.
  expect(toml).toContain('compatibility_flags = ["nodejs_compat"]');
  // nodejs_compat v2 needs a date at or after 2024-09-23; the old hardcoded value was
  // exactly that floor and two years stale.
  const date = /compatibility_date = "([\d-]+)"/.exec(toml)[1];
  expect(Date.parse(date)).toBeGreaterThan(Date.parse('2024-09-23'));
});

test('secrets are listed even when they were left blank', async () => {
  // Not having R2 keys at scaffold time is the normal case, and it is exactly when the
  // list of what to set is worth having.
  const { steps, files } = await plan([
    ['Object storage', true], ['  Backend', 's3'], ['  Bucket', 'b'],
    ['  Access key id', ''], ['  Secret access key', ''],
    ['Semantic search', false], ['Identity', false], ['Access control', false],
    ['D1 (metadata)', false], ['Vectorize (semantic search)', false],
    ['Bind Workers AI', false], ['Bind the TroveTasks', false],
  ], 'workers');
  const cmds = steps.map((s) => s.cmd);
  expect(cmds).toContain('npx wrangler secret put TROVE_S3_ACCESS_KEY_ID');
  expect(cmds).toContain('npx wrangler secret put TROVE_S3_SECRET_ACCESS_KEY');
  // The example is committed and says what to copy it to; the real .dev.vars is not.
  expect(fileNamed(files, '.dev.vars.example')).toBeTruthy();
  expect(fileNamed(files, '.dev.vars')).toBeUndefined();
});

test('a local VAPID pair is generated, and never the production one', async () => {
  // Web push was implemented in the server the whole time and unreachable from a
  // scaffolded drive, because the wizard never asked. Asking is not enough on its own,
  // though: a P-256 pair is not something anyone has lying around, and the first
  // version of this question pointed at a helper inside a package that is not installed
  // until after the wizard has exited.
  const { files, steps } = await plan([
    ['Object storage', false], ['Semantic search', false], ['Identity', false],
    ['Access control', false],
    ['Push notifications', true],
    ['  Production public key', 'prod-public-half'],
    ['Installed app name', false],
    ['D1 (metadata)', false], ['Vectorize (semantic search)', false],
    ['Bind Workers AI', false], ['Bind the TroveTasks', false],
  ], 'workers');

  const toml = fileNamed(files, 'wrangler.toml').contents;
  expect(toml).toContain('TROVE_VAPID_PUBLIC_KEY = "prod-public-half"');
  expect(toml).toContain('TROVE_VAPID_SUBJECT = "mailto:admin@example.com"');

  // The production PRIVATE key is never asked for and never written. It goes from
  // `npm run vapid` into `wrangler secret put` without passing through a file.
  expect(steps.map((s) => s.cmd)).toContain('npx wrangler secret put TROVE_VAPID_PRIVATE_KEY');
  expect(toml).not.toContain('TROVE_VAPID_PRIVATE_KEY =');

  // The LOCAL pair is generated and lands only in the gitignored file. A private key in
  // the committed example is a private key every clone of the repo shares.
  const devVars = fileNamed(files, '.dev.vars').contents;
  expect(devVars).toContain('TROVE_VAPID_PUBLIC_KEY=dev-public-half');
  expect(devVars).toContain('TROVE_VAPID_PRIVATE_KEY=dev-private-half');
  expect(fileNamed(files, '.dev.vars.example').contents).not.toContain('dev-private-half');

  // And a way to mint the production pair, from inside the project, where the package
  // it needs actually exists.
  expect(fileNamed(files, 'dev/vapid.js')).toBeTruthy();
  expect(JSON.parse(fileNamed(files, 'package.json').contents).scripts.vapid).toBe('node dev/vapid.js');
});

test('the local key is different from the production one', async () => {
  // Two application servers, two identities. It also means the value sitting on a
  // laptop is worth nothing to anyone who takes it.
  const { files } = await plan([
    ['Object storage', false], ['Semantic search', false], ['Identity', false],
    ['Access control', false],
    ['Push notifications', true], ['  Production public key', 'prod-public-half'],
    ['Installed app name', false],
    ['D1 (metadata)', false], ['Vectorize (semantic search)', false],
    ['Bind Workers AI', false], ['Bind the TroveTasks', false],
  ], 'workers');
  expect(fileNamed(files, 'wrangler.toml').contents).not.toContain('dev-public-half');
  expect(fileNamed(files, '.dev.vars').contents).toContain('dev-public-half');
});

test('declining push still documents the keys', async () => {
  const { files } = await plan([...WORKERS_SCRIPT], 'workers');
  // WORKERS_SCRIPT does not answer the push section, so it takes its default: off.
  const toml = fileNamed(files, 'wrangler.toml').contents;
  expect(toml).toContain('# TROVE_VAPID_PUBLIC_KEY');
  expect(toml).toContain('Push notifications  (skipped)');
});

test('the README never tells you to overwrite a .dev.vars that was written', async () => {
  // The two were computed independently: renderWorkers wrote .dev.vars when a key pair
  // was generated OR a secret was answered, and the README asked whether a secret was
  // answered. Generate a pair without answering a secret and the README instructed a
  // `cp` over the only copy of the local private key.
  const script = (push) => [
    ['Object storage', false], ['Semantic search', false], ['Identity', false],
    ['Access control', false],
    ['Push notifications', push], ...(push ? [['  Production public key', '']] : []),
    ['Installed app name', false],
    ['D1 (metadata)', false], ['Vectorize (semantic search)', false],
    ['Bind Workers AI', false], ['Bind the TroveTasks', false],
  ];

  // A generated pair, no answered credential — the case that broke.
  const generated = await plan(script(true), 'workers');
  expect(fileNamed(generated.files, '.dev.vars')).toBeTruthy();
  expect(fileNamed(generated.files, 'README.md').contents).not.toContain('cp .dev.vars.example .dev.vars');

  // Nothing to preserve: copying the example is exactly right, and still advised.
  const bare = await plan(script(false), 'workers');
  expect(fileNamed(bare.files, '.dev.vars')).toBeUndefined();
  expect(fileNamed(bare.files, 'README.md').contents).toContain('cp .dev.vars.example .dev.vars');
});
