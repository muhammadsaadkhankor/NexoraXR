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
