// Frame encryption for WebRTC encoded media. Pure functions so they can be unit-tested in Node.
//
// Wire format of an encrypted frame:
//   [ clear header | 12-byte IV | AES-GCM ciphertext + 16-byte tag ]
// The clear header is left readable because the RTP packetiser still needs to parse it
// (Opus TOC byte, VP8 frame tag). It is not secret, but it is authenticated as additional data,
// so tampering with it makes the frame fail to decrypt.

const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export const OVERHEAD = IV_LENGTH + TAG_LENGTH;

/** Bytes of the payload that must stay in the clear for the codec's packetiser. */
export function headerLength(kind, frameType) {
  if (kind === 'audio') return 1; // Opus table-of-contents byte
  return frameType === 'key' ? 10 : 3; // VP8: frame tag (+ start code and size on key frames)
}

export async function encryptFrame(key, bytes, kind, frameType) {
  const hl = Math.min(headerLength(kind, frameType), bytes.length);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const header = bytes.subarray(0, hl);
  const ct = new Uint8Array(
    await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: header, tagLength: 128 }, key, bytes.subarray(hl)),
  );
  const out = new Uint8Array(hl + IV_LENGTH + ct.length);
  out.set(header, 0);
  out.set(iv, hl);
  out.set(ct, hl + IV_LENGTH);
  return out;
}

/** Returns the plain frame bytes, or null if the frame doesn't authenticate. */
export async function decryptFrame(key, bytes, kind, frameType) {
  const hl = Math.min(headerLength(kind, frameType), bytes.length);
  if (bytes.length < hl + OVERHEAD) return null;
  try {
    const header = bytes.subarray(0, hl);
    const iv = bytes.subarray(hl, hl + IV_LENGTH);
    const pt = new Uint8Array(
      await globalThis.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv, additionalData: header, tagLength: 128 },
        key,
        bytes.subarray(hl + IV_LENGTH),
      ),
    );
    const out = new Uint8Array(hl + pt.length);
    out.set(header, 0);
    out.set(pt, hl);
    return out;
  } catch {
    return null;
  }
}
