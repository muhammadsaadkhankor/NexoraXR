import React, { useState, useRef, useEffect } from 'react';
import { useSpeech } from '../hooks/useSpeech';

const ContinuousRecorder = () => {
  const [isRecording, setIsRecording] = useState(false);
  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const audioContextRef = useRef(null);
  const { message, onMessagePlayed } = useSpeech();
  const destinationRef = useRef(null);
  const currentAudioRef = useRef(null);

  const getSupportedMimeType = () => {
    const types = [
      'video/webm;codecs=vp8,opus',
      'video/webm;codecs=h264,opus',
      'video/webm'
    ];
    return types.find(type => MediaRecorder.isTypeSupported(type));
  };

  // Auto start/stop recording based on message presence
  useEffect(() => {
    if (message && !isRecording) {
      startRecording();
    } else if (!message && isRecording) {
      stopRecording();
    }
  }, [message]);

  // Handle new audio messages while recording
  useEffect(() => {
    if (isRecording && message && audioContextRef.current && destinationRef.current) {
      if (currentAudioRef.current) {
        currentAudioRef.current.pause();
        currentAudioRef.current = null;
      }
  
      const playMessage = async () => {
        try {
          const audioElement = new Audio("data:audio/mp3;base64," + message.audio);
          currentAudioRef.current = audioElement;
  
          await new Promise((resolve, reject) => {
            audioElement.addEventListener('loadedmetadata', resolve);
            audioElement.addEventListener('error', reject);
          });
  
          const source = audioContextRef.current.createMediaElementSource(audioElement);
          source.connect(destinationRef.current);
          source.connect(audioContextRef.current.destination);
          
          await audioElement.play();
  
          // Only call onMessagePlayed when NOT recording
          audioElement.onended = () => {
            if (!isRecording) {
              setTimeout(() => {
                onMessagePlayed();
              }, 100);
            }
          };
        } catch (error) {
          console.error('Error playing audio:', error);
          if (!isRecording) {
            onMessagePlayed();
          }
        }
      };
  
      playMessage();
    }
  }, [message, isRecording]);

  const startRecording = async () => {
    try {
      chunksRef.current = [];
      
      const canvas = document.querySelector('canvas');
      if (!canvas) {
        throw new Error('Canvas element not found');
      }

      audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)();
      destinationRef.current = audioContextRef.current.createMediaStreamDestination();

      const canvasStream = canvas.captureStream(30);
      const combinedStream = new MediaStream([
        ...canvasStream.getVideoTracks(),
        ...destinationRef.current.stream.getAudioTracks()
      ]);

      const mimeType = getSupportedMimeType();
      if (!mimeType) {
        throw new Error('No supported mime type found');
      }

      const mediaRecorder = new MediaRecorder(combinedStream, {
        mimeType,
        videoBitsPerSecond: 3000000,
        audioBitsPerSecond: 128000
      });

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = () => {
        if (chunksRef.current.length === 0) return;

        const blob = new Blob(chunksRef.current, { type: mimeType });
        if (blob.size === 0) return;

        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        document.body.appendChild(a);
        a.style = 'display: none';
        a.href = url;
        a.download = `avatar-recording-${Date.now()}.webm`;
        a.click();

        setTimeout(() => {
          URL.revokeObjectURL(url);
          document.body.removeChild(a);
        }, 100);
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
    if (currentAudioRef.current) {
      currentAudioRef.current.pause();
      currentAudioRef.current = null;
    }

    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
    }
    
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    
    destinationRef.current = null;
    setIsRecording(false);
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (isRecording) {
        stopRecording();
      }
    };
  }, [isRecording]);

  // Optional: Return null since we don't need the buttons anymore
  return null;
};

export default ContinuousRecorder;

