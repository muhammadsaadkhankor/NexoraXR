import React, { useState, useRef, useEffect } from 'react';
import { useSpeech } from '../hooks/useSpeech';

const ContinuousRecorder = () => {
  const [isRecording, setIsRecording] = useState(false);
  const [recordedVideoUrl, setRecordedVideoUrl] = useState(null);
  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const recordStreamRef = useRef(null);
  const tappedElementRef = useRef(null);
  const { message, audioElementRef } = useSpeech();

  const getSupportedMimeType = () => {
    const types = [
      'video/mp4;codecs=h264,aac',
      'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
      'video/mp4',
      'video/webm;codecs=vp8,opus',
      'video/webm'
    ];
    return types.find(type => MediaRecorder.isTypeSupported(type));
  };

  // Passively tap the audio element that the professor Avatar is already
  // playing. captureStream()/mozCaptureStream() only read the element's
  // output — they never call play() and never reroute or duplicate audio.
  const tapSharedAudioElement = () => {
    const el = audioElementRef?.current;
    const stream = recordStreamRef.current;
    if (!isRecording || !stream || !el || tappedElementRef.current === el) return;
    const capture = el.captureStream || el.mozCaptureStream;
    if (typeof capture !== 'function') {
      console.warn('[ContinuousRecorder] HTMLMediaElement.captureStream not supported; recording video only.');
      return;
    }
    tappedElementRef.current = el;
    try {
      stream.getAudioTracks().forEach((t) => stream.removeTrack(t));
      capture.call(el).getAudioTracks().forEach((t) => stream.addTrack(t));
    } catch (err) {
      console.warn('[ContinuousRecorder] unable to capture professor audio:', err);
    }
  };

  // Auto start/stop recording based on message presence
  useEffect(() => {
    if (message && !isRecording) {
      startRecording();
    } else if (!message && isRecording) {
      stopRecording();
    }
  }, [message]);

  // While recording, keep the recorded audio tracks bound to whichever audio
  // element the speech queue is currently playing. A short interval is used
  // because Avatar assigns audioElementRef inside its own effect.
  useEffect(() => {
    if (!isRecording) return;
    tapSharedAudioElement();
    const id = setInterval(tapSharedAudioElement, 250);
    return () => clearInterval(id);
  }, [isRecording, message]);

  const startRecording = async () => {
    try {
      chunksRef.current = [];
      tappedElementRef.current = null;

      const canvas = document.querySelector('canvas');
      if (!canvas) {
        throw new Error('Canvas element not found');
      }

      const canvasStream = canvas.captureStream(30);
      const combinedStream = new MediaStream([
        ...canvasStream.getVideoTracks()
      ]);
      recordStreamRef.current = combinedStream;

      const mimeType = getSupportedMimeType();
      if (!mimeType) {
        throw new Error('No supported mime type found');
      }

      const recorderOptions = {
        mimeType,
        videoBitsPerSecond: 3000000,
        audioBitsPerSecond: 128000
      };

      const mediaRecorder = new MediaRecorder(combinedStream, recorderOptions);

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        if (chunksRef.current.length === 0) return;

        const blob = new Blob(chunksRef.current, { type: mimeType });
        if (blob.size === 0) return;

        const url = URL.createObjectURL(blob);
        setRecordedVideoUrl(url);
      };

      mediaRecorderRef.current = mediaRecorder;
      mediaRecorder.start(1000);
      setIsRecording(true);

    } catch (error) {
      console.error('Error in startRecording:', error);
      setIsRecording(false);
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
    if (recordStreamRef.current) {
      recordStreamRef.current.getTracks().forEach(track => track.stop());
      recordStreamRef.current = null;
    }
    tappedElementRef.current = null;
    mediaRecorderRef.current = null;
    setIsRecording(false);
  };

  const handleDownload = () => {
    if (recordedVideoUrl) {
      const a = document.createElement('a');
      a.href = recordedVideoUrl;

      const mimeType = getSupportedMimeType();
      const extension = mimeType && mimeType.includes('mp4') ? 'mp4' : 'webm';

      a.download = `avatar-recording-${Date.now()}.${extension}`;
      a.click();
    }
  };

  // Add cleanup for URL when component unmounts
  useEffect(() => {
    return () => {
      if (recordedVideoUrl) {
        URL.revokeObjectURL(recordedVideoUrl);
      }
    };
  }, [recordedVideoUrl]);

  return (
    <div className="fixed bottom-20 left-4 z-20 flex flex-col gap-2">
      {/* Download button - only visible when there's a recording */}
      {recordedVideoUrl && (
        <button
          onClick={handleDownload}
          className="flex items-center gap-2 p-3 rounded-lg bg-green-500 text-white bg-opacity-70 backdrop-blur-md cursor-pointer hover:bg-opacity-90"
        >
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
          </svg>
          Download Video
        </button>
      )}
    </div>
  );
};

export default ContinuousRecorder;
