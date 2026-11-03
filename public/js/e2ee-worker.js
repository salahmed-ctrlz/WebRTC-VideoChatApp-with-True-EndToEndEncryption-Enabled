// Runs inside a Worker. Every RTCRtpSender / RTCRtpReceiver gets an RTCRtpScriptTransform that
// points here; frames are encrypted just before they are packetised and decrypted right after
// they are reassembled, so neither the network nor any relay ever sees plain media.
import { encryptFrame, decryptFrame } from './frame-crypto.js';

self.onrtctransform = (event) => {
  const { transformer } = event;
  const { operation, key, kind, peerId } = transformer.options;
  const stats = { encrypted: 0, decrypted: 0, dropped: 0 };
  let lastReport = 0;
  const report = () => {
    const now = Date.now();
    if (now - lastReport < 1000) return;
    lastReport = now;
    self.postMessage({ type: 'stats', peerId, operation, kind, ...stats });
  };

  const transform = async (frame, controller) => {
    const bytes = new Uint8Array(frame.data);
    // `type` is undefined for audio frames; for video it is 'key' or 'delta'.
    const frameType = frame.type;
    if (operation === 'encrypt') {
      frame.data = (await encryptFrame(key, bytes, kind, frameType)).buffer;
      stats.encrypted++;
      controller.enqueue(frame);
    } else {
      const plain = await decryptFrame(key, bytes, kind, frameType);
      if (!plain) {
        // Wrong key, tampered or unencrypted frame: never hand it to the decoder.
        stats.dropped++;
        report();
        return;
      }
      frame.data = plain.buffer;
      stats.decrypted++;
      controller.enqueue(frame);
    }
    report();
  };

  transformer.readable.pipeThrough(new TransformStream({ transform })).pipeTo(transformer.writable);
};
