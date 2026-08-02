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
  if (typeof cover.src === 'string') return cover.src;
  if (!Number.isFinite(cover.range?.start) || !Number.isFinite(cover.range?.end)) return null;
  try {
    const blob = await ctx.files.blob(file.id);
    const bytes = await blob.slice(cover.range.start, cover.range.end).bytes();
    if (!bytes?.length) return null;
    return URL.createObjectURL(new Blob([bytes], { type: cover.contentType || 'image/jpeg' }));
  } catch {
    return null; // a missing cover is not a reason to fail opening a book
  }
}
