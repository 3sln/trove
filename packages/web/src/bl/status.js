// What the drive is doing and how full it is — one answer, for every surface that says so.
//
// This lived in the status bar and was imported from there by the phone chrome, which is
// how it was already admitting to being shared: two shells rendering the same facts in
// different shapes. It is a derivation over four resources, so it belongs here, and it is
// reached as the `statusFacts` query rather than recomputed per render.
//
// The reason it has to be derived ONCE rather than twice is on the record: the phone bar
// rendered `collectionId` raw and showed an opaque `col_…` where the desktop bar showed the
// collection's name — the same fact, said two ways, because each surface worked it out.

/**
 * The facts every shell reports.
 *
 * @param {{ex: object, tr: object, act: object, off: object}} slices
 */
export function statusFactsOf({ ex = {}, tr = {}, act = {}, off = {} } = {}) {
  const items = ex.items || [];
  const tasks = act.tasks || [];
  return {
    // `null` with nothing open — `collectionLabelOf` renders that as "no collection". The
    // old fallback made the bar name a collection that may not exist, on a drive where the
    // user had not yet chosen one.
    collectionId: ex.collectionId ?? null,
    // What to CALL it, so the phone shell and the desktop bar cannot end up saying
    // different things.
    collectionLabel: collectionLabelOf(ex),
    // The COLLECTION's totals when the server could give them, not the page's. Summing what
    // happens to be loaded reports a 3,000-file drive as 500 files — a wrong number, not a
    // rounded one. Falls back to the page only when the server didn't say.
    totalItems: ex.stats?.items ?? items.length,
    // Whether that total is the COLLECTION's or just the page we happen to hold. With more
    // pages waiting, the page length is a floor, not a total, and must read as one.
    totalKnown: ex.stats?.items != null,
    totalBytes: ex.stats?.bytes ?? items.reduce((n, i) => n + (i.size || 0), 0),
    shown: items.length,
    partial: !!ex.nextCursor,
    usage: ex.usage ?? null,
    usageLevel: usageLevelOf(ex.usage),
    uploading: (tr.items || []).filter((t) => t.status === 'active'),
    running: tasks.filter((t) => t.status === 'running'),
    issues: act.issues || [],
    off: { online: true, pins: [], queued: 0, syncing: false, ...off },
  };
}

/** The open collection's name, or the plainest true thing when there isn't one. */
export function collectionLabelOf(ex) {
  if (!ex?.collectionId) return 'no collection';
  const match = (ex.collections || []).find((c) => c.id === ex.collectionId);
  return match?.name || ex.collectionId;
}

/**
 * How worried to be about space, or '' when there is nothing to say.
 *
 * A filesystem or NAS can answer exactly, and that is where it matters: a disk fills up and
 * every upload starts failing with no warning that anything was coming. An object store has
 * no equivalent number, so this answers '' and the meter is not drawn at all rather than
 * being drawn meaninglessly.
 *
 * The thresholds are a judgement about when someone still has time to act, which is why
 * they are here and not in whichever bar happens to be on screen.
 */
export function usageLevelOf(usage) {
  if (!usage?.total) return '';
  const free = usage.available / usage.total;
  return free < 0.05 ? 'critical' : free < 0.1 ? 'low' : '';
}

/**
 * The one thing worth saying about the drive right now, most urgent first.
 *
 * The phone has room for a single glyph, so something has to decide what outranks what:
 * being offline beats a standing problem, a standing problem beats work in progress, and
 * anything beats running low on space. That ordering is a claim about which condition a
 * person most needs to know, which makes it a decision rather than a rendering.
 *
 * Answers a KIND, not an icon. Which glyph draws a kind is the shell's business.
 */
export function driveConditionOf(facts) {
  const f = facts || {};
  if (!f.off?.online) return { kind: 'offline', label: 'Offline' };
  if (f.issues?.length) {
    return {
      kind: 'issues',
      label: `${f.issues.length} need${f.issues.length === 1 ? 's' : ''} attention`,
      count: f.issues.length,
    };
  }
  if (f.running?.length || f.uploading?.length || f.off?.syncing) {
    return { kind: 'working', label: 'Working…', count: (f.running?.length || 0) + (f.uploading?.length || 0) };
  }
  if (f.usageLevel) return { kind: 'lowSpace', label: 'Low on space' };
  return { kind: 'idle', label: 'Status' };
}
