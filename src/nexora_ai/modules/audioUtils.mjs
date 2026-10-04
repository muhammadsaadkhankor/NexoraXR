export function pcm16ToWav(pcm, sampleRate = 24000, channels = 1) {
  const dataSize = pcm.byteLength;
  const totalSize = 44 + dataSize;
  const wavBuffer = new ArrayBuffer(totalSize);
  const view = new DataView(wavBuffer);
  let pos = 0;

  const setUint32 = (v) => {
    view.setUint32(pos, v, true);
    pos += 4;
  };
  const setUint16 = (v) => {
    view.setUint16(pos, v, true);
    pos += 2;
  };

  setUint32(0x46464952); // 'RIFF'
  setUint32(totalSize - 8);
  setUint32(0x45564157); // 'WAVE'
  setUint32(0x20746d66); // 'fmt '
  setUint32(16);
  setUint16(1); // PCM
  setUint16(channels);
  setUint32(sampleRate);
  setUint32(sampleRate * channels * 2);
  setUint16(channels * 2);
  setUint16(16);
  setUint32(0x61746164); // 'data'
  setUint32(dataSize);

  new Uint8Array(wavBuffer, 44).set(new Uint8Array(pcm));
  return wavBuffer;
}

// Duration of a RIFF/WAVE buffer in milliseconds, parsed by walking the
// chunk list (robust to extra chunks and non-44-byte headers).
// Returns null if the buffer isn't a parseable WAV or has no data chunk.
export function wavDurationMs(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    return null;
  }
  let byteRate = null;
  let dataSize = null;
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ') byteRate = buf.readUInt32LE(pos + 12);
    if (id === 'data') { dataSize = size; break; }
    pos += 8 + size + (size % 2); // chunks are word-aligned
  }
  if (!byteRate || dataSize == null) return null;
  return Math.round((dataSize / byteRate) * 1000);
}
