// The transfer tray can be dismissed while it is transferring.
//
// It used to open on `items.length` alone with no close — "Clear finished" was the only
// control, and by definition it cannot remove something still running. So the panel sat
// over the drive for the whole of a large upload, which is exactly when someone wants to
// keep using the drive.
//
// Closing it stops nothing. It is a view of the work, not the work.

import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';

const overlays = readFileSync(new URL('../src/ui/components/overlays.js', import.meta.url), 'utf8');
const status = readFileSync(new URL('../src/ui/components/statusBar.js', import.meta.url), 'utf8');
const commands = readFileSync(new URL('../src/bl/commands.js', import.meta.url), 'utf8');

test('the tray has a close, and honours the dismissal', () => {
  expect(overlays).toMatch(/transfersDismissed/);
  expect(overlays).toMatch(/Hide transfers/);
  // Returned BEFORE the panel is built, so a dismissed tray costs nothing to not draw.
  expect(overlays).toMatch(/if \(state\.vs\?\.transfersDismissed\) return null;/);
});

test('the dismissal is forgotten once the transfers are gone', () => {
  // Otherwise the next upload — a fresh decision, minutes later — inherits a choice made
  // about transfers that no longer exist, and the tray silently never appears again.
  expect(overlays).toMatch(/if \(state\.vs\?\.transfersDismissed\) ui\.engine\.dispatch/);
});

test('the status bar shows transfers even when none are active', () => {
  // A failed upload from two minutes ago is the case where someone most wants the panel
  // back, and the segment used to vanish the moment the transfer stopped.
  expect(status).toMatch(/transfers\.length\s*\n?\s*\?/);
  expect(status).not.toMatch(/^\s*active\.length\s*$\n\s*\? button\(\{ className: 'seg', title: 'Active uploads/m);
});

test('clicking the status segment toggles the panel rather than cancelling', () => {
  // Cancelling one transfer belongs in the panel, beside that transfer. The status bar's
  // job is to say "there is transfer activity" and be the handle for it.
  expect(status).toMatch(/workbench\.transfers\.toggle/);
});

test('there is a command, so it is bindable and in the palette', () => {
  expect(commands).toMatch(/cmd\('workbench\.transfers\.toggle'/);
  expect(commands).toMatch(/Toggle Transfers Panel/);
  // In the palette: `palette: false` would make the command unreachable by name, which is
  // half the point of having one.
  const line = commands.split('\n').find((l) => l.includes("'workbench.transfers.toggle'"));
  expect(line).not.toMatch(/palette:\s*false/);
});
