/**
 * Copy bytes into a standalone `ArrayBuffer`-backed view.
 *
 * Two reasons, one typing and one substantive. TypeScript models `Uint8Array` as
 * generic over its backing buffer, and WebCrypto's `BufferSource` will not
 * accept the `ArrayBufferLike` default that a `Buffer` or a widened array
 * carries. And a Node `Buffer` read from a database driver is frequently a view
 * into a shared pool, so copying guarantees the bytes handed to WebCrypto are
 * exactly the ones we meant and nothing more.
 *
 * These values are key- and credential-sized, so the copy is free in practice.
 */
export function toBufferSource(view: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(view.byteLength);
  copy.set(view);
  return copy;
}
