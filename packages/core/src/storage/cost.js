// What a bulk pass over a collection will cost at the storage provider.
//
// Re-encrypting a collection is the first operation here big enough for the answer to
// matter: the server reads every object and writes it back, so on a metered store it is a
// real bill, and on a large collection it can be a surprising one. Someone should be able
// to see the number before they press the button, not on an invoice.
//
// Two things shape how this is written.
//
// THE MODEL OUTLASTS THE NUMBERS. "R2 does not charge for egress, so this costs operations
// only" stays true long after any per-GB figure is stale. So every provider carries a
// plain-language description of WHAT is charged, and that is what leads; the rates are
// supporting detail, stamped with the date they were taken and linked to the source.
//
// WE WILL BE WRONG EVENTUALLY. Prices change, free tiers change, and a drive can be years
// old. Nothing here is presented as authoritative: an estimate says where its figures came
// from and when, and every answer links the provider's own pricing page. An unrecognised
// endpoint gets an honest description of how object stores usually bill rather than a
// fabricated number.

/**
 * When these rates were last checked. Shown with every estimate, because a figure without
 * a date invites being trusted longer than it deserves.
 */
export const RATES_AS_OF = '2026-07';

/**
 * What we think we know, per provider.
 *
 * `egress` is the field that actually decides whether a rotation is cheap or expensive, and
 * it is the one worth getting right: a store that does not charge for reads out is a store
 * where this operation costs pennies regardless of size.
 */
const PROVIDERS = [
  {
    id: 'r2',
    name: 'Cloudflare R2',
    match: /\.r2\.cloudflarestorage\.com$/i,
    docs: 'https://developers.cloudflare.com/r2/pricing/',
    egress: 'none',
    egressNote: 'R2 does not charge for data transferred out, which is the cost that would otherwise dominate this.',
    // Class B is reads, Class A is writes.
    readPerMillion: 0.36,
    writePerMillion: 4.50,
    egressPerGB: 0,
  },
  {
    id: 'aws',
    name: 'Amazon S3',
    // Covers the regional forms (s3.eu-west-2, s3-us-west-2), the legacy global endpoint
    // (s3.amazonaws.com), and virtual-host style (bucket.s3.region.amazonaws.com).
    match: /(^|\.)s3([.-][a-z0-9-]+)?\.amazonaws\.com$/i,
    docs: 'https://aws.amazon.com/s3/pricing/',
    egress: 'metered',
    // The nuance that changes the answer by orders of magnitude, and the one people are
    // most often caught by.
    egressNote:
      'S3 charges for data transferred out to the internet. If this drive runs outside AWS '
      + '(on Cloudflare Workers, for example) every byte read is billed at that rate; if it runs '
      + 'in EC2 or Lambda in the same region as the bucket, transfer is normally free and this '
      + 'costs requests only.',
    readPerMillion: 400,
    writePerMillion: 5000,
    egressPerGB: 0.09,
  },
  {
    id: 'b2',
    name: 'Backblaze B2',
    match: /(^|\.)backblazeb2\.com$/i,
    docs: 'https://www.backblaze.com/cloud-storage/pricing',
    egress: 'allowance',
    egressNote:
      'B2 includes free egress up to a multiple of what you store, and charges beyond it. A '
      + 'one-off pass over a collection often falls inside that allowance.',
    readPerMillion: 4,
    writePerMillion: 0,
    egressPerGB: 0.01,
  },
  {
    id: 'wasabi',
    name: 'Wasabi',
    match: /(^|\.)wasabisys\.com$/i,
    docs: 'https://wasabi.com/cloud-storage-pricing',
    egress: 'none',
    egressNote:
      'Wasabi does not charge for egress or requests. Note its minimum storage duration, '
      + 'though: rewriting an object can restart the clock on what the original was charged for.',
    readPerMillion: 0,
    writePerMillion: 0,
    egressPerGB: 0,
  },
  {
    id: 'spaces',
    name: 'DigitalOcean Spaces',
    match: /(^|\.)digitaloceanspaces\.com$/i,
    docs: 'https://www.digitalocean.com/pricing/spaces-object-storage',
    egress: 'allowance',
    egressNote: 'Spaces includes a monthly transfer allowance and charges per GB beyond it.',
    readPerMillion: 0,
    writePerMillion: 0,
    egressPerGB: 0.01,
  },
  {
    id: 'gcs',
    name: 'Google Cloud Storage',
    match: /(^|\.)storage\.googleapis\.com$/i,
    docs: 'https://cloud.google.com/storage/pricing',
    egress: 'metered',
    egressNote:
      'GCS charges for data read out to the internet, and for operations. Reading from within '
      + 'Google Cloud in the same region is normally free.',
    readPerMillion: 400,
    writePerMillion: 5000,
    egressPerGB: 0.12,
  },
];

/**
 * Stores where this question does not arise.
 *
 * A directory on a disk and a NATS object store are not metered by anyone, so offering a
 * cost estimate would be inventing a concern.
 */
const UNMETERED_DRIVERS = new Set(['filesystem', 'memory', 'nats']);

/** Which provider an endpoint belongs to, or null if we do not recognise it. */
export function recognizeProvider(endpoint) {
  if (!endpoint) return null;
  let host;
  try {
    host = new URL(endpoint).hostname;
  } catch {
    return null;
  }
  return PROVIDERS.find((p) => p.match.test(host)) || null;
}

const gb = (bytes) => bytes / 1024 ** 3;
const money = (n) => Math.round(n * 100) / 100;

/**
 * What re-encrypting a collection will cost.
 *
 * The work is one read and one write per object, plus the bytes moving out of the bucket
 * and back in. Ingress is free essentially everywhere, so it is named and not priced.
 *
 * @param {object} target
 * @param {string} target.driver     the collection's store driver
 * @param {string} [target.endpoint] its S3 endpoint, if it has one
 * @param {number} objects  how many objects will be rewritten
 * @param {number} bytes    how many bytes they hold
 */
export function estimateRotationCost({ driver, endpoint } = {}, { objects = 0, bytes = 0 } = {}) {
  if (UNMETERED_DRIVERS.has(driver)) {
    return {
      applicable: false,
      provider: null,
      summary: 'This collection is on storage nobody bills you for, so a rotation costs only the time it takes.',
      lines: [],
      total: null,
      docs: null,
      asOf: RATES_AS_OF,
    };
  }

  const p = recognizeProvider(endpoint);
  const work = [
    { label: 'Objects read and rewritten', value: `${objects.toLocaleString()}` },
    { label: 'Data moved out of the bucket', value: `${gb(bytes).toFixed(2)} GB` },
    // Named rather than priced: essentially no object store charges to receive bytes, and
    // an estimate that lists a zero invites the reader to wonder what it is hiding.
    { label: 'Data written back', value: `${gb(bytes).toFixed(2)} GB (ingress is not normally charged)` },
  ];

  if (!p) {
    // Honest rather than invented. Describing how these services usually bill is more use
    // than a number we made up for a host we have never seen.
    return {
      applicable: true,
      provider: null,
      confidence: 'unknown',
      summary:
        'We do not recognise this storage endpoint, so we cannot estimate a price. Object stores '
        + 'usually charge for three things: the requests made, the data read back out, and what is '
        + 'stored. A rotation makes one read and one write per object and moves every byte out and '
        + 'back — so if your provider charges for egress, that is what will dominate.',
      lines: work,
      total: null,
      docs: null,
      asOf: RATES_AS_OF,
    };
  }

  const egressCost = gb(bytes) * p.egressPerGB;
  const readCost = (objects / 1e6) * p.readPerMillion;
  const writeCost = (objects / 1e6) * p.writePerMillion;
  const total = egressCost + readCost + writeCost;

  const lines = [
    ...work,
    { label: 'Reads', value: `$${money(readCost).toFixed(2)}` },
    { label: 'Writes', value: `$${money(writeCost).toFixed(2)}` },
    {
      label: 'Egress',
      value: p.egress === 'none' ? 'not charged' : `$${money(egressCost).toFixed(2)}`,
      note: p.egressNote,
    },
  ];

  return {
    applicable: true,
    provider: p.name,
    confidence: 'known',
    // Leads with the model, because that is the part that stays true.
    summary: p.egress === 'none'
      ? `${p.name} does not charge for data transferred out, so this costs operations only.`
      : `${p.name} charges for data read out of the bucket, so the size of this collection is what drives the price.`,
    lines,
    total: { amount: money(total), currency: 'USD', approximate: true },
    docs: p.docs,
    asOf: RATES_AS_OF,
    // Said in the estimate itself, not left to the UI to remember.
    caveat:
      `These figures are what we recorded in ${RATES_AS_OF} and prices change — treat this as an `
      + `order of magnitude, not a quote, and check ${p.name}'s own pricing page for what you will `
      + 'actually be billed. Free tiers and committed-use discounts are not accounted for here.',
  };
}
