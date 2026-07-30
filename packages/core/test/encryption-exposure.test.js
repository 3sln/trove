// Saying what encryption does not cover.
//
// "Encrypted" on its own is true and misleading: the bucket holds ciphertext, and anything
// that indexes a file still reads it in the clear — that is what indexing IS, and it is why
// search keeps working. The useful disclosure is not about encryption but about who reads
// your files and where they may send what they read.

import { test, expect } from 'bun:test';
import { describeExposure } from '../src/encryption/exposure.js';

const builtins = [
  { id: 'text', displayName: 'Text' },
  { id: 'image', displayName: 'Images' },
];
const pluginIndexer = { id: 'trove+contrib:acme.com/summarizer/idx', displayName: 'AI Summaries' };
const plugins = [{
  id: 'acme.com/summarizer',
  manifest: { name: 'summarizer', capabilities: { network: { endpoints: ['https://api.acme.com'] } } },
}];
const endpointsOf = (m) => m?.capabilities?.network?.endpoints || [];

test('built-in indexers are named as such and send nothing anywhere', () => {
  const e = describeExposure({ indexers: builtins, encryption: { enabled: true } });
  expect(e.indexers.every((i) => i.source === 'built-in')).toBe(true);
  expect(e.indexers.every((i) => i.endpoints.length === 0)).toBe(true);
  expect(e.anyEgress).toBe(false);
  expect(e.egressSummary).toMatch(/No indexer .* may send file contents anywhere/);
});

test('a plugin indexer is attributed to its plugin and to the hosts it may reach', () => {
  // Read off the manifest the plugin is actually constrained by, so the disclosure cannot
  // drift from what it is permitted.
  const e = describeExposure({
    indexers: [...builtins, pluginIndexer], plugins, endpointsOf, encryption: { enabled: true },
  });
  const row = e.indexers.find((i) => i.id === pluginIndexer.id);
  expect(row.source).toBe('plugin');
  expect(row.pluginId).toBe('acme.com/summarizer');
  expect(row.endpoints).toEqual(['https://api.acme.com']);
  expect(e.anyEgress).toBe(true);
  expect(e.egressSummary).toMatch(/1 of 3 indexers may send file contents outside this drive/);
});

test('a plugin that declares no network access is shown as reaching nowhere', () => {
  // The common case, and worth stating rather than leaving to inference: being third-party
  // code is not the same as being able to phone home.
  const local = [{ id: 'acme.com/localonly', manifest: { name: 'localonly', capabilities: {} } }];
  const e = describeExposure({
    indexers: [{ id: 'trove+contrib:acme.com/localonly/idx', displayName: 'Local' }],
    plugins: local, endpointsOf, encryption: { enabled: true },
  });
  expect(e.indexers[0].source).toBe('plugin');
  expect(e.indexers[0].endpoints).toEqual([]);
  expect(e.anyEgress).toBe(false);
});

test('the scope of the encryption is stated, not left to be inferred', () => {
  const e = describeExposure({ indexers: builtins, encryption: { enabled: true } });
  expect(e.encrypted).toBe(true);
  expect(e.protects).toMatch(/before they reach the storage provider/);
  // The two things people over-read, said out loud.
  expect(e.protects).toMatch(/not end-to-end/);
  expect(e.protects).toMatch(/reads it in the clear/);
});

test('an unencrypted collection claims no protection', () => {
  const e = describeExposure({ indexers: builtins, encryption: null });
  expect(e.encrypted).toBe(false);
  expect(e.protects).toBe(null);
  // The egress question is still worth answering — it was never about encryption.
  expect(e.indexers.length).toBe(2);
});

test('a collection nothing indexes says so', () => {
  const e = describeExposure({ indexers: [], encryption: { enabled: true } });
  expect(e.egressSummary).toMatch(/Nothing indexes this collection/);
  expect(e.anyEgress).toBe(false);
});

test('duplicate declared endpoints are reported once', () => {
  const noisy = [{
    id: 'acme.com/x',
    manifest: { name: 'x', capabilities: { network: { endpoints: ['https://a.test', 'https://a.test'] } } },
  }];
  const e = describeExposure({
    indexers: [{ id: 'trove+contrib:acme.com/x/idx' }], plugins: noisy, endpointsOf,
  });
  expect(e.indexers[0].endpoints).toEqual(['https://a.test']);
});

test('an indexer from a plugin that is not installed is not silently called built-in', () => {
  // It would be the most dangerous mislabel available: third-party code presented as ours.
  const e = describeExposure({
    indexers: [{ id: 'trove+contrib:ghost.com/gone/idx' }], plugins: [], endpointsOf,
  });
  expect(e.indexers[0].source).toBe('plugin');
  // And with no manifest we cannot claim it reaches nowhere — `[]` would be an affirmative
  // safety claim we have no basis for, so it is unknown and counted among the risks.
  expect(e.indexers[0].endpoints).toBe(null);
  expect(e.anyEgress).toBe(true);
  expect(e.egressSummary).toMatch(/could not be checked/);
});
