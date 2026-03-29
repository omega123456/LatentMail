/**
 * Coerce a Buffer or Uint8Array to a Buffer.
 *
 * Structured-clone (used by worker_threads postMessage) silently converts
 * Buffer instances to plain Uint8Array on the receiving side.  This helper
 * normalises back to a Node Buffer so callers can use Buffer-specific APIs
 * (e.g. `.toString('base64')`).
 */
export function coerceToBuffer(value: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}
