# 007 — Encrypted multipart uploads are sequential

The plaintext upload path runs parts concurrently (four by default). The encrypted path
cannot: parts are slices of the envelope rather than of the file, and the envelope is
produced in order because each chunk's nonce is derived from its position. So a large upload
to an encrypted collection is slower than the same file to a plain one, by roughly the
concurrency factor on a link where round-trip time dominates.

This is a real cost of the design, not a defect, and it may be the right trade. Worth
measuring before optimising.

## What could be done

**Seal ahead of sending.** Encryption is fast relative to the network, so the producer could
run ahead of the uploader and keep a small queue of sealed parts, letting several be in
flight at once. Parts can be uploaded out of order — S3 assembles by part number — so only
the *sealing* is inherently sequential, not the sending. This is probably the whole fix.

**Bound the queue**, or a fast disk and a slow link reproduce the memory problem the
streaming rewrite existed to solve. Two or three parts is likely enough to saturate.

## Notes

- Sealing must stay strictly ordered: chunk n's nonce is `prefix || n`, and producing them
  out of order would either reuse a nonce or leave a gap. The queue reorders *sending*, never
  *sealing*.
- The single-PUT path is unaffected; this only applies above the multipart threshold.
- Measure first. If the sealing is a small fraction of the transfer time, a queue of two
  recovers most of the loss and anything more is noise.

## Done when

A large upload to an encrypted collection is within a reasonable factor of the same upload
to an unencrypted one, with a bounded amount of sealed data held in memory.
