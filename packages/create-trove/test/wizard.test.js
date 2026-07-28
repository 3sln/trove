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

async function plan(script, runtime) {
  const p = scripted(script);
  const result = await askPlan(p, { name: 'my-drive', version: VERSION, runtime });
  return { plan: result, ...renderProject(result), unanswered: p.unanswered() };
}

// --- the coupling both packages exist to keep -------------------------------

test('create-trove and trove carry the same version', () => {
  // Released together from one repository, so the scaffolder can pin the exact version
  // it was built alongside without looking anything up. If these ever drift, a
  // scaffolded project pairs a server with a workbench from a different release — the
  // whole failure mode that shipping one package was meant to end.
  const here = path.resolve(import.meta.dir, '..');
  const mine = JSON.parse(readFileSync(path.join(here, 'package.json'), 'utf8'));
  const trove = JSON.parse(readFileSync(path.resolve(here, '../../package.json'), 'utf8'));
  expect(mine.name).toBe('@3sln/create-trove');
  expect(trove.name).toBe('@3sln/trove');
  expect(mine.version).toBe(trove.version);
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
  ['Vectorize (semantic search)', true], ['  Index name', 'trove'], ['  Dimensions', '1536'],
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
  expect(fileNamed(files, '.dev.vars').contents).toContain('TROVE_S3_SECRET_ACCESS_KEY=sekrit');
  expect(fileNamed(files, '.gitignore').contents).toContain('.dev.vars');
});

test('every resource named in the config also has a command to create it', async () => {
  const { steps } = await plan([...WORKERS_SCRIPT], 'workers');
  const cmds = steps.map((s) => s.cmd);
  // The most common way a first Workers deploy fails is a binding pointing at something
  // that was never created — which deploys fine and breaks at request time.
  expect(cmds).toContain('npx wrangler d1 create trove');
  expect(cmds).toContain('npx wrangler vectorize create trove --dimensions=1536 --metric=cosine');
  expect(cmds).toContain('npx wrangler r2 bucket create trove-objects');
  expect(cmds.at(-1)).toBe('npx wrangler deploy');
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
