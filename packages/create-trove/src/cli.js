#!/usr/bin/env node
//
//   npm create @3sln/trove my-drive
//
// Asks where the drive will run, then writes a project that runs there.
//
// The version this pins @3sln/trove at is *this package's own*. The two are released
// together from one repository and one version number, so they are the same string by
// construction — which means a scaffolded project can never pair a server with a
// workbench from a different release, and there is no version to look up at runtime.
//
// It is also usable by something that cannot read a prompt. `--set key=value` supplies
// answers up front, `--json` puts a machine-readable result on stdout with every human
// word on stderr, and `--describe` lists the keys rather than making a caller read this
// file to find them. Keys are a flat namespace (`storage.bucket`) rather than the text
// of a question, because the wording of a question is not an interface and rewording a
// hint should not break a caller.

import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createPrompter, presetPrompter } from './prompt.js';
import { askPlan, RUNTIMES } from './plan.js';
import { renderProject } from './render.js';
import { describeQuestions } from './index.js';

const USAGE = `Usage: npm create @3sln/trove <directory> [options]

Options:
  --runtime <bun|node|workers>  skip the first question
  --set <key=value>             answer one question; repeatable (see --describe)
  --config <file.json>          answer many, as a flat { "key": value } object
  --yes                         take every default, ask nothing
  --json                        machine-readable result on stdout, prose on stderr
  --describe                    list every question key and exit
  --dry-run                     report what would be written, write nothing
  --force                       write into a directory that is not empty
  --help                        this

Answers given by --set and --config are taken as-is; anything left over is asked
interactively, or defaulted when there is no terminal. A key that is never asked for
is an error, since it is either a typo or a setting the other answers ruled out.
`;

function parseArgs(argv) {
  const opts = {
    dir: null, runtime: null, yes: false, dryRun: false, force: false,
    help: false, json: false, describe: false, config: null, set: {},
  };
  const value = (a, i, flag) => (a.startsWith(`${flag}=`) ? a.slice(flag.length + 1) : argv[++i.v]);
  for (const i = { v: 0 }; i.v < argv.length; i.v++) {
    const a = argv[i.v];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--yes' || a === '-y') opts.yes = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--describe') opts.describe = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--force') opts.force = true;
    else if (a.startsWith('--runtime')) opts.runtime = value(a, i, '--runtime');
    else if (a.startsWith('--config')) opts.config = value(a, i, '--config');
    else if (a.startsWith('--set')) {
      const raw = value(a, i, '--set');
      const eq = String(raw ?? '').indexOf('=');
      if (eq < 1) throw new Error(`--set wants key=value, got "${raw}"`);
      opts.set[raw.slice(0, eq)] = raw.slice(eq + 1);
    } else if (a.startsWith('-')) throw new Error(`Unknown option "${a}"`);
    else if (!opts.dir) opts.dir = a;
  }
  return opts;
}

/** npm package names: no leading dot/underscore, no uppercase, no spaces. */
const toPackageName = (dirName) =>
  dirName.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[._-]+/, '').replace(/-+$/, '') || 'trove-drive';

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n\n${USAGE}`);
    return 2;
  }
  if (opts.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (opts.runtime && !RUNTIMES.includes(opts.runtime)) {
    process.stderr.write(`--runtime must be one of: ${RUNTIMES.join(', ')}\n`);
    return 2;
  }

  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

  // Prose goes to stderr under --json, so stdout is one parseable document and nothing
  // else. Without that split a caller has to strip the banner before it can parse, which
  // is the sort of thing that works until someone adds a line to the banner.
  const say = opts.json ? (s) => process.stderr.write(s) : (s) => process.stdout.write(s);
  const emit = (obj) => process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);

  if (opts.describe) {
    const questions = await describeQuestions({ version });
    if (opts.json) emit({ version, questions });
    else {
      process.stdout.write(`\nEvery question, by key. Use --set key=value.\n\n`);
      for (const q of questions) {
        const opt = q.options ? `  (${q.options.map((o) => o.value).join(' | ')})` : '';
        process.stdout.write(`  ${q.key.padEnd(30)} ${q.kind}${opt}\n`);
        process.stdout.write(`  ${''.padEnd(30)} ${q.label} — default ${JSON.stringify(q.default)}\n`);
        if (q.runtimes.length < RUNTIMES.length) {
          process.stdout.write(`  ${''.padEnd(30)} only for: ${q.runtimes.join(', ')}\n`);
        }
        process.stdout.write('\n');
      }
    }
    return 0;
  }

  let answers = { ...opts.set };
  if (opts.config) {
    try {
      const parsed = JSON.parse(await readFile(path.resolve(opts.config), 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('expected a flat JSON object of key/value pairs');
      }
      // --set wins, so a config file can be a base that one flag overrides.
      answers = { ...parsed, ...opts.set };
    } catch (err) {
      process.stderr.write(`Could not read ${opts.config}: ${err.message}\n`);
      return 2;
    }
  }

  // A pipe rather than a terminal means nobody is there to answer, so take the defaults
  // instead of blocking forever on a read that will never return.
  const interactive = process.stdin.isTTY && !opts.yes && !opts.json;
  const base = createPrompter({ assumeDefaults: !interactive, output: opts.json ? process.stderr : process.stdout });
  const prompter = presetPrompter(answers, base);

  try {
    say(`\ncreate-trove ${version}\n`);

    const dir = opts.dir || (interactive
      ? await base.text('\nProject directory', { default: 'my-drive' })
      : 'my-drive');
    const target = path.resolve(dir);
    const name = toPackageName(path.basename(target));

    if (existsSync(target) && !opts.force) {
      const entries = await readdir(target);
      if (entries.length) {
        process.stderr.write(`\n${target} is not empty. Use --force to write into it anyway.\n`);
        return 1;
      }
    }

    let plan;
    let rendered;
    try {
      plan = await askPlan(prompter, { name, version, runtime: opts.runtime });
      rendered = renderProject(plan);
    } catch (err) {
      // A bad --set value: name the key rather than making someone map a stack trace
      // back to a flag they typed.
      process.stderr.write(`\n${err.message}\n`);
      return 2;
    }
    const { files, steps } = rendered;

    // Either it was a typo or the other answers ruled the question out. Both are worth
    // refusing over: an agent that thinks it set a bucket should not get a drive with
    // no bucket and a zero exit code.
    const unused = prompter.unused();
    if (unused.length) {
      process.stderr.write(`\nThese answers were never asked for: ${unused.join(', ')}\n`);
      process.stderr.write('Either the key is wrong (see --describe) or another answer ruled the question out.\n');
      return 2;
    }

    if (!opts.dryRun) {
      for (const f of files) {
        const dest = path.join(target, f.path);
        await mkdir(path.dirname(dest), { recursive: true });
        await writeFile(dest, f.contents);
      }
    }

    if (opts.json) {
      emit({
        version,
        directory: target,
        written: !opts.dryRun,
        runtime: plan.runtime,
        files: files.map((f) => f.path),
        steps: steps.map((s) => ({ command: s.cmd, why: s.why || undefined })),
        skipped: plan.skipped,
        warnings: plan.warnings.map((w) => (typeof w === 'string' ? { kind: w } : w)),
      });
      return 0;
    }

    say(`\n${opts.dryRun ? 'Would write' : 'Writing'} ${files.length} files to ${target}\n`);
    for (const f of files) say(`  ${f.path}\n`);
    say('\nNext:\n');
    for (const s of steps) say(`  ${s.cmd}${s.why ? `    # ${s.why}` : ''}\n`);
    if (plan.skipped.length) {
      say(`\nSkipped, and left commented in the config for you: ${plan.skipped.join(', ')}.\n`);
    }
    for (const w of plan.warnings) {
      const kind = typeof w === 'string' ? w : w.kind;
      if (kind === 'anonymous') say('\nNo identity configured — anyone who can reach this has full access.\n');
      if (kind === 'incomplete-identity') say(`\nTROVE_AUTH=${w.driver} is set but ${w.missing.join(' and ')} left blank.\n`);
      if (kind === 'default-open') say('The default collection is open to every user.\n');
    }
    say('\n');
    return 0;
  } finally {
    base.close();
  }
}

process.exitCode = await main();
