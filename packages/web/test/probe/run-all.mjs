// Runs every probe sequentially (each is a standalone process so a browser crash in
// one can't take down the others) and reports a combined pass/fail. These are the
// error-path / edge-case regression checks that don't belong in the strict e2e suite
// (they deliberately trigger 404s, server faults, etc.).
//
//   node packages/web/test/probe/run-all.mjs
// Requires a fresh build (bun packages/web/build.mjs).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const probes = fs.readdirSync(dir).filter((f) => /^probe\d.*\.mjs$/.test(f)).sort();

function run(file) {
  return new Promise((resolve) => {
    const p = spawn('node', [path.join(dir, file)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const grab = (d) => { out += d.toString(); };
    p.stdout.on('data', grab);
    p.stderr.on('data', grab);
    const kill = setTimeout(() => p.kill('SIGKILL'), 60_000);
    p.on('close', (code) => {
      clearTimeout(kill);
      const m = out.match(/(\d+)\/(\d+) checks passed/);
      const ok = m && m[1] === m[2] && code === 0;
      console.log(`${ok ? '✓' : '✗'} ${file} — ${m ? m[0] : 'no result'}${code ? ` (exit ${code})` : ''}`);
      resolve(ok);
    });
  });
}

let allOk = true;
for (const f of probes) allOk = (await run(f)) && allOk;
console.log(`\n${allOk ? 'ALL PROBES PASSED' : 'SOME PROBES FAILED'}`);
process.exit(allOk ? 0 : 1);
