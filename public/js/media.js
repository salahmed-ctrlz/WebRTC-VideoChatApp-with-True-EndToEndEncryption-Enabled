const VIDEO = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } };
const AUDIO = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

/**
 * Ask for camera and microphone, degrading gracefully: both, then each on its own.
 * Returns { audio, video } tracks (either may be null) and the last error, if any.
 */
export async function getLocalMedia({ audioId, videoId, wantAudio = true, wantVideo = true } = {}) {
  const constraints = (a, v) => ({
    audio: a ? (audioId ? { ...AUDIO, deviceId: { exact: audioId } } : AUDIO) : false,
    video: v ? (videoId ? { ...VIDEO, deviceId: { exact: videoId } } : { ...VIDEO, facingMode: 'user' }) : false,
  });
  const attempts = [];
  if (wantAudio && wantVideo) attempts.push([true, true]);
  if (wantVideo) attempts.push([false, true]);
  if (wantAudio) attempts.push([true, false]);

  let error = null;
  const out = { audio: null, video: null, error: null };
  for (const [a, v] of attempts) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints(a, v));
      out.audio ||= stream.getAudioTracks()[0] || null;
      out.video ||= stream.getVideoTracks()[0] || null;
      // Take what we got, then try to fill in whatever is still missing in a later attempt.
      if ((!wantAudio || out.audio) && (!wantVideo || out.video)) break;
    } catch (e) {
      error = e;
    }
  }
  if (out.video) out.video.contentHint = 'motion';
  out.error = out.audio || out.video ? null : error;
  return out;
}

export async function listDevices() {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    return {
      cameras: all.filter((d) => d.kind === 'videoinput'),
      mics: all.filter((d) => d.kind === 'audioinput'),
      speakers: all.filter((d) => d.kind === 'audiooutput'),
    };
  } catch {
    return { cameras: [], mics: [], speakers: [] };
  }
}

export const canShareScreen = () => !!navigator.mediaDevices?.getDisplayMedia && !/Android|iPhone|iPad/i.test(navigator.userAgent);
export const canPickSpeaker = () => 'setSinkId' in HTMLMediaElement.prototype;

export async function getScreen() {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: 15, max: 30 } },
    audio: true,
  });
  for (const t of stream.getVideoTracks()) t.contentHint = 'detail';
  return stream;
}

/** Level meter (0..1) for a MediaStream. Call the returned function to stop. */
export function watchLevel(stream, onLevel, ctx = new AudioContext()) {
  if (!stream.getAudioTracks().length) return () => {};
  const src = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  src.connect(analyser);
  const buf = new Uint8Array(analyser.fftSize);
  const timer = setInterval(() => {
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += ((v - 128) / 128) ** 2;
    onLevel(Math.min(1, Math.sqrt(sum / buf.length) * 4));
  }, 100);
  return () => {
    clearInterval(timer);
    src.disconnect();
  };
}
