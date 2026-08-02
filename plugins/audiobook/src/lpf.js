// W3C Audiobooks / LPF.
//
// An `.lpf` is a zip holding a JSON-LD `publication.json` (media type
// `application/lpf+zip`). The spec is schema.org-flavoured, which means almost every field
// can legitimately arrive in three shapes — a string, an object with a `name`, or an array
// of either — so most of this file is shape-wrangling rather than logic.
//
// PURE on purpose: bytes in, a description out. No zip library, no fetch, no plugin. The
// caller unzips (the drive already ships fflate, so there is no reason to carry a second
// zip implementation into a sandbox) and hands the manifest text here.

/** Whatever schema.org meant by "one value", as a string. */
export function oneOf(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return oneOf(value[0]);
  if (typeof value === 'object') return oneOf(value.name ?? value['@value'] ?? value.value);
  return String(value);
}

/** The same, as a list — because `author` is one person or five and both are normal. */
export function listOf(value) {
  if (value == null) return [];
  const items = Array.isArray(value) ? value : [value];
  return items.map(oneOf).filter(Boolean);
}

/**
 * ISO 8601 durations, as seconds.
 *
 * A reading order entry carries `duration: "PT1H2M3S"`, and it is the ONLY place a
 * per-track length is stated — without it a player cannot lay tracks out on a timeline
 * until it has loaded every one of them, which for a forty-track book means forty requests
 * before the first second of audio.
 */
export function parseDuration(text) {
  if (typeof text === 'number') return text;
  if (typeof text !== 'string') return null;
  const m = /^P(?:([\d.]+)D)?(?:T(?:([\d.]+)H)?(?:([\d.]+)M)?(?:([\d.]+)S)?)?$/.exec(text.trim());
  if (!m) return null;
  const [, d, h, min, s] = m.map((v) => (v == null ? 0 : Number(v)));
  const total = d * 86400 + h * 3600 + min * 60 + s;
  return Number.isFinite(total) && total > 0 ? total : null;
}

/**
 * A publication manifest, as something a player can use.
 *
 * `readingOrder` is the audio, in order. Everything else is presentation.
 *
 * @param {string} text the contents of publication.json
 * @returns {{title: string|null, authors: string[], duration: number|null, cover: string|null,
 *   tracks: Array<{href: string, type: string|null, duration: number|null, title: string|null}>}}
 */
export function parsePublication(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw new Error(`publication.json is not valid JSON: ${err.message}`);
  }
  const order = doc.readingOrder ?? doc.resources ?? [];
  const entries = Array.isArray(order) ? order : [order];

  const tracks = entries
    .map((e) => (typeof e === 'string' ? { url: e } : e))
    .filter((e) => e && (e.url || e.href))
    .map((e) => ({
      // The spec says `url`; plenty of files in the wild say `href`, and reading both costs
      // one `??` against a book that otherwise does not open at all.
      href: String(e.url ?? e.href),
      type: e.encodingFormat ? String(e.encodingFormat) : null,
      duration: parseDuration(e.duration),
      title: oneOf(e.name),
    }));

  return {
    title: oneOf(doc.name),
    authors: listOf(doc.author ?? doc.creator),
    // A stated total beats a computed one — a book whose tracks have no durations still
    // knows how long it is, and that is what a progress bar needs before track one loads.
    duration: parseDuration(doc.duration) ?? sumDurations(tracks),
    cover: coverOf(doc),
    tracks,
  };
}

const sumDurations = (tracks) =>
  (tracks.every((t) => t.duration) ? tracks.reduce((n, t) => n + t.duration, 0) : null);

function coverOf(doc) {
  const res = Array.isArray(doc.resources) ? doc.resources : [];
  const rel = res.find((r) => r && (r.rel === 'cover' || (Array.isArray(r.rel) && r.rel.includes('cover'))));
  if (rel) return String(rel.url ?? rel.href ?? '');
  const image = oneOf(doc.image);
  return image || null;
}

/**
 * Chapters from a reading order.
 *
 * An LPF book has no chapter list of its own — its tracks ARE its chapters, which is the
 * shape a book split into files has always had. Laid onto one timeline so the player can
 * treat LPF and M4B identically above this line: one duration, one position, one chapter
 * list, whatever the container underneath is.
 */
export function chaptersFrom(tracks) {
  let at = 0;
  return tracks.map((t, i) => {
    const chapter = { time: at, title: t.title || `Track ${i + 1}`, href: t.href, duration: t.duration };
    at += t.duration || 0;
    return chapter;
  });
}

/** Which entry in a zip is the manifest. `publication.json` at the root, per the spec. */
export const MANIFEST_PATH = 'publication.json';

/**
 * Find the manifest in an unzipped map, tolerating one level of wrapping.
 *
 * A zip made by selecting a folder rather than its contents nests everything one level
 * down, which is the single most common way a valid book fails to open.
 */
export function manifestEntry(files) {
  if (files[MANIFEST_PATH]) return MANIFEST_PATH;
  const found = Object.keys(files).find((p) => p.endsWith(`/${MANIFEST_PATH}`));
  return found || null;
}

/** Resolve a track href against wherever the manifest turned out to be. */
export function resolveHref(manifestPath, href) {
  const base = manifestPath.includes('/') ? manifestPath.slice(0, manifestPath.lastIndexOf('/') + 1) : '';
  if (!base || href.startsWith('/')) return href.replace(/^\//, '');
  return base + href;
}
