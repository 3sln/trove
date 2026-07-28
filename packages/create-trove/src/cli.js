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

import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createPrompter } from './prompt.js';
import { askPlan, RUNTIMES } from './plan.js';
import { renderProject } from './render.js';

const USAGE = `Usage: npm create @3sln/trove <directory> [options]

Options:
  --runtime <bun|node|workers>  skip the first question
  --yes                         take every default, ask nothing
  --dry-run                     print what would be written, write nothing
  --force                       write into a directory that is not empty
  --help                        this
`;

function parseArgs(argv) {
  const opts = { dir: null, runtime: null, yes: false, dryRun: false, force: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--yes' || a === '-y') opts.yes = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--force') opts.force = true;
    else if (a === '--runtime') opts.runtime = argv[++i];
    else if (a.startsWith('--runtime=')) opts.runtime = a.slice('--runtime='.length);
    else if (!a.startsWith('-') && !opts.dir) opts.dir = a;
  }
  return opts;
}

/** npm package names: no leading dot/underscore, no uppercase, no spaces. */
const toPackageName = (dirName) =>
  dirName.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[._-]+/, '').replace(/-+$/, '') || 'trove-drive';

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (opts.runtime && !RUNTIMES.includes(opts.runtime)) {
    process.stderr.write(`--runtime must be one of: ${RUNTIMES.join(', ')}\n`);
    return 1;
  }

  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

  // A pipe rather than a terminal means nobody is there to answer, so take the defaults
  // instead of blocking forever on a read that will never return.
  const interactive = process.stdin.isTTY && !opts.yes;
  const prompter = createPrompter({ assumeDefaults: !interactive });

  try {
    process.stdout.write(`\ncreate-trove ${version}\n`);

    const dir = opts.dir || (interactive
      ? await prompter.text('\nProject directory', { default: 'my-drive' })
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

    const plan = await askPlan(prompter, { name, version, runtime: opts.runtime });
    const { files, steps } = renderProject(plan);

    process.stdout.write(`\n${opts.dryRun ? 'Would write' : 'Writing'} ${files.length} files to ${target}\n`);
    for (const f of files) process.stdout.write(`  ${f.path}\n`);

    if (!opts.dryRun) {
      for (const f of files) {
        const dest = path.join(target, f.path);
        await mkdir(path.dirname(dest), { recursive: true });
        await writeFile(dest, f.contents);
      }
    }

    process.stdout.write('\nNext:\n');
    for (const s of steps) process.stdout.write(`  ${s.cmd}${s.why ? `    # ${s.why}` : ''}\n`);
    if (plan.skipped.length) {
      process.stdout.write(`\nSkipped, and left commented in the config for you: ${plan.skipped.join(', ')}.\n`);
    }
    for (const w of plan.warnings) {
      const kind = typeof w === 'string' ? w : w.kind;
      if (kind === 'anonymous') process.stdout.write('\nNo identity configured — anyone who can reach this has full access.\n');
      if (kind === 'incomplete-identity') process.stdout.write(`\nTROVE_AUTH=${w.driver} is set but ${w.missing.join(' and ')} left blank.\n`);
      if (kind === 'default-open') process.stdout.write('The default collection is open to every user.\n');
    }
    process.stdout.write('\n');
    return 0;
  } finally {
    prompter.close();
  }
}

process.exitCode = await main();
