// The cover, from the indexer's descriptor to something an <img> can take.

/**
 * Turn the indexer's cover descriptor into something an <img> can take.
 *
 * A RANGE is the normal case — the art sits in the m4b's `covr` atom and the contribution
 * points at it rather than carrying 57 KB of base64 on every listing — so the bytes are
 * fetched here, once, through the same ranged reader everything else uses. A `src` is
 * already a data: URL and passes straight through.
 *
 * Both end up as something the frame's CSP allows (`img-src blob: data:`). Never a remote
 * URL, which the sandbox would block exactly as it blocks remote audio.
 */
export async function loadCover(ctx, file, cover) {
  if (!cover) return null;
  // A data: URL is already both: drawable here, and loadable by the host.
  if (typeof cover.src === 'string') return { url: cover.src, artwork: cover.src };
  if (!Number.isFinite(cover.range?.start) || !Number.isFinite(cover.range?.end)) return null;
  try {
    const blob = await ctx.files.blob(file.id);
    const bytes = await blob.slice(cover.range.start, cover.range.end).bytes();
    if (!bytes?.length) return null;
    const type = cover.contentType || 'image/jpeg';
    return {
      // For the <img> in THIS frame. An object URL costs nothing and needs no copy.
      url: URL.createObjectURL(new Blob([bytes], { type })),
      // For the media session, which the HOST sets. This frame is on an opaque origin, so
      // an object URL it mints is `blob:null/…` and the host page cannot load one — the
      // browser refuses it as "Not allowed to load local resource" against a document
      // that never mentions the plugin. The lock-screen image just never appeared.
      //
      // So artwork crosses as BYTES. Roughly a third larger base64'd, once per open, for
      // a picture the OS is going to draw anyway.
      artwork: `data:${type};base64,${base64(bytes)}`,
    };
  } catch {
    return null; // a missing cover is not a reason to fail opening a book
  }
}

/** Base64 without blowing the argument limit on a 60 KB cover. */
function base64(bytes) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}
