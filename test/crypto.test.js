import test from 'node:test';
import assert from 'node:assert/strict';
import {
  newRoomId, newSecret, parseMeeting, formatMeetingHash, deriveRoomKeys, deriveSenderKey, seal, open, isRoomId, isSecret,
} from '../public/js/crypto.js';
import { encryptFrame, decryptFrame, OVERHEAD } from '../public/js/frame-crypto.js';

test('ids and secrets have the expected shape and are unique', () => {
  const ids = new Set(Array.from({ length: 200 }, newRoomId));
  assert.equal(ids.size, 200);
  assert.ok([...ids].every(isRoomId));
  assert.ok(isSecret(newSecret()));
  assert.ok(!isSecret('short'));
});

test('meeting links round-trip and reject junk', () => {
  const roomId = newRoomId();
  const secret = newSecret();
  const hash = formatMeetingHash(roomId, secret);
  assert.deepEqual(parseMeeting(`https://example.com/#${hash}`), { roomId, secret });
  assert.deepEqual(parseMeeting(`#${hash}`), { roomId, secret });
  assert.deepEqual(parseMeeting(` ${hash} `), { roomId, secret });
  assert.equal(parseMeeting(roomId), null, 'room id without key is not joinable');
  assert.equal(parseMeeting(`${roomId}.nope`), null);
  assert.equal(parseMeeting(`${hash}.extra`), null);
  assert.equal(parseMeeting(''), null);
});

test('same secret -> same safety code; different secret or room -> different code', async () => {
  const roomId = newRoomId();
  const secret = newSecret();
  const a = await deriveRoomKeys(roomId, secret);
  const b = await deriveRoomKeys(roomId, secret);
  const c = await deriveRoomKeys(roomId, newSecret());
  const d = await deriveRoomKeys(newRoomId(), secret);
  assert.equal(a.safetyCode, b.safetyCode);
  assert.notEqual(a.safetyCode, c.safetyCode);
  assert.notEqual(a.safetyCode, d.safetyCode);
  assert.match(a.safetyCode, /^[0-9A-F]{4} [0-9A-F]{4} [0-9A-F]{2}$/);
});

test('sealed messages open with the right key and context only', async () => {
  const roomId = newRoomId();
  const secret = newSecret();
  const { signalKey } = await deriveRoomKeys(roomId, secret);
  const other = (await deriveRoomKeys(roomId, newSecret())).signalKey;
  const sealed = await seal(signalKey, { sdp: 'v=0...' }, roomId, 'alice', 'bob');

  assert.deepEqual(await open(signalKey, sealed, roomId, 'alice', 'bob'), { sdp: 'v=0...' });
  assert.equal(await open(other, sealed, roomId, 'alice', 'bob'), null, 'wrong key');
  assert.equal(await open(signalKey, sealed, roomId, 'mallory', 'bob'), null, 'relay changed the sender');
  assert.equal(await open(signalKey, sealed, roomId, 'alice', 'carol'), null, 'relay re-addressed it');
  assert.equal(await open(signalKey, sealed, newRoomId(), 'alice', 'bob'), null, 'moved to another room');

  const flipped = sealed.slice(0, -2) + (sealed.at(-2) === 'A' ? 'B' : 'A') + sealed.at(-1);
  assert.equal(await open(signalKey, flipped, roomId, 'alice', 'bob'), null, 'tampered');
  assert.equal(await open(signalKey, 'garbage', roomId, 'alice', 'bob'), null);
});

test('frames: encrypt/decrypt round trip keeps the clear header and hides the payload', async () => {
  const { mediaRoot } = await deriveRoomKeys(newRoomId(), newSecret());
  const key = await deriveSenderKey(mediaRoot, 'alice');
  for (const [kind, type, hl] of [['audio', undefined, 1], ['video', 'key', 10], ['video', 'delta', 3]]) {
    const plain = new Uint8Array(200).map((_, i) => (i * 7 + 3) & 255);
    const enc = await encryptFrame(key, plain, kind, type);
    assert.equal(enc.length, plain.length + OVERHEAD);
    assert.deepEqual(enc.subarray(0, hl), plain.subarray(0, hl), 'header stays readable for the packetiser');
    assert.notDeepEqual(enc.subarray(hl + 12, hl + 12 + 32), plain.subarray(hl, hl + 32), 'payload is not plaintext');
    assert.deepEqual(await decryptFrame(key, enc, kind, type), plain);
  }
});

test('frames: wrong sender key, tampering and plain frames are all rejected', async () => {
  const { mediaRoot } = await deriveRoomKeys(newRoomId(), newSecret());
  const alice = await deriveSenderKey(mediaRoot, 'alice');
  const bob = await deriveSenderKey(mediaRoot, 'bob');
  const plain = new Uint8Array(120).fill(9);
  const enc = await encryptFrame(alice, plain, 'video', 'delta');

  assert.equal(await decryptFrame(bob, enc, 'video', 'delta'), null, 'keys are per sender');
  const header = Uint8Array.from(enc);
  header[0] ^= 1;
  assert.equal(await decryptFrame(alice, header, 'video', 'delta'), null, 'clear header is authenticated');
  const body = Uint8Array.from(enc);
  body[body.length - 1] ^= 1;
  assert.equal(await decryptFrame(alice, body, 'video', 'delta'), null, 'ciphertext tampering');
  assert.equal(await decryptFrame(alice, plain, 'video', 'delta'), null, 'unencrypted frame');
  assert.equal(await decryptFrame(alice, new Uint8Array(5), 'audio'), null, 'too short');
});

test('frame IVs are not reused', async () => {
  const { mediaRoot } = await deriveRoomKeys(newRoomId(), newSecret());
  const key = await deriveSenderKey(mediaRoot, 'alice');
  const ivs = new Set();
  for (let i = 0; i < 500; i++) {
    const f = await encryptFrame(key, new Uint8Array(20), 'audio');
    ivs.add(Buffer.from(f.subarray(1, 13)).toString('hex'));
  }
  assert.equal(ivs.size, 500);
});
