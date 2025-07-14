// // ContinuousRecorder.jsx
// import React, { useState, useRef, useEffect } from 'react';
// import { useSpeech } from '../hooks/useSpeech';

// const ContinuousRecorder = () => {
//   const [isRecording, setIsRecording] = useState(false);
//   const [recordedVideoUrl, setRecordedVideoUrl] = useState(null);
//   const mediaRecorderRef = useRef(null);
//   const chunksRef = useRef([]);
//   const audioContextRef = useRef(null);
//   const { message, onMessagePlayed } = useSpeech();
//   const destinationRef = useRef(null);
//   const currentAudioRef = useRef(null);

//   const getSupportedMimeType = () => {
//     const types = [
//       'video/webm;codecs=vp8,opus',
//       'video/webm;codecs=h264,opus',
//       'video/webm'
//     ];
//     return types.find(type => MediaRecorder.isTypeSupported(type));
//   };

//   // Auto start/stop recording based on message presence
//   useEffect(() => {
//     if (message && !isRecording) {
//       startRecording();
//     } else if (!message && isRecording) {
//       stopRecording();
//     }
//   }, [message]);

//   // Handle new audio messages while recording
//   useEffect(() => {
//     if (isRecording && message && audioContextRef.current && destinationRef.current) {
//       if (currentAudioRef.current) {
//         currentAudioRef.current.pause();
//         currentAudioRef.current = null;
//       }
  
//       const playMessage = async () => {
//         try {
//           const audioElement = new Audio("data:audio/mp3;base64," + message.audio);
//           currentAudioRef.current = audioElement;
  
//           await new Promise((resolve, reject) => {
//             audioElement.addEventListener('loadedmetadata', resolve);
//             audioElement.addEventListener('error', reject);
//           });
  
//           const source = audioContextRef.current.createMediaElementSource(audioElement);
//           source.connect(destinationRef.current);
//           source.connect(audioContextRef.current.destination);
          
//           await audioElement.play();
  
//           audioElement.onended = () => {
//             if (!isRecording) {
//               setTimeout(() => {
//                 onMessagePlayed();
//               }, 100);
//             }
//           };
//         } catch (error) {
//           console.error('Error playing audio:', error);
//           if (!isRecording) {
//             onMessagePlayed();
//           }
//         }
//       };
  
//       playMessage();
//     }
//   }, [message, isRecording]);

//   const startRecording = async () => {
//     try {
//       chunksRef.current = [];
      
//       const canvas = document.querySelector('canvas');
//       if (!canvas) {
//         throw new Error('Canvas element not found');
//       }

//       audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)();
//       destinationRef.current = audioContextRef.current.createMediaStreamDestination();

//       const canvasStream = canvas.captureStream(30);
//       const combinedStream = new MediaStream([
//         ...canvasStream.getVideoTracks(),
//         ...destinationRef.current.stream.getAudioTracks()
//       ]);

//       const mimeType = getSupportedMimeType();
//       if (!mimeType) {
//         throw new Error('No supported mime type found');
//       }

//       const mediaRecorder = new MediaRecorder(combinedStream, {
//         mimeType,
//         videoBitsPerSecond: 3000000,
//         audioBitsPerSecond: 128000
//       });

//       mediaRecorder.ondataavailable = (event) => {
//         if (event.data.size > 0) {
//           chunksRef.current.push(event.data);
//         }
//       };

//       mediaRecorder.onstop = () => {
//         if (chunksRef.current.length === 0) return;

//         const blob = new Blob(chunksRef.current, { type: mimeType });
//         if (blob.size === 0) return;

//         const url = URL.createObjectURL(blob);
//         setRecordedVideoUrl(url);
//       };

//       mediaRecorderRef.current = mediaRecorder;
//       mediaRecorder.start(1000);
//       setIsRecording(true);

//     } catch (error) {
//       console.error('Error in startRecording:', error);
//       setIsRecording(false);
//     }
//   };

//   const stopRecording = () => {
//     if (currentAudioRef.current) {
//       currentAudioRef.current.pause();
//       currentAudioRef.current = null;
//     }

//     if (mediaRecorderRef.current?.state === 'recording') {
//       mediaRecorderRef.current.stop();
//       mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
//     }
    
//     if (audioContextRef.current) {
//       audioContextRef.current.close();
//       audioContextRef.current = null;
//     }
    
//     destinationRef.current = null;
//     setIsRecording(false);
//   };

//   const handleDownload = () => {
//     if (recordedVideoUrl) {
//       const a = document.createElement('a');
//       a.href = recordedVideoUrl;
//       a.download = `avatar-recording-${Date.now()}.webm`;
//       a.click();
//     }
//   };

//   // Add cleanup for URL when component unmounts
//   useEffect(() => {
//     return () => {
//       if (recordedVideoUrl) {
//         URL.revokeObjectURL(recordedVideoUrl);
//       }
//     };
//   }, [recordedVideoUrl]);

//   // Position buttons above the settings button at the bottom
//   return (
//     <div className="fixed bottom-20 left-4 z-20 flex flex-col gap-2">
//       {/* Record button at the top */}
//       <button 
//         onClick={isRecording ? null : startRecording}
//         className={`flex items-center gap-2 p-3 rounded-lg ${
//           isRecording 
//             ? "bg-gray-400 cursor-not-allowed" 
//             : "bg-white bg-opacity-70 backdrop-blur-md cursor-pointer hover:bg-opacity-90"
//         }`}
//       >
//         <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
//           <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
//           <path strokeLinecap="round" strokeLinejoin="round" d="M15.91 11.672a.375.375 0 010 .656l-5.603 3.113a.375.375 0 01-.557-.328V8.887c0-.286.307-.466.557-.327l5.603 3.112z" />
//         </svg>
//         Record
//       </button>
      
//       {/* Stop button - always visible but only enabled when recording */}
//       <button 
//         onClick={isRecording ? stopRecording : null}
//         className={`flex items-center gap-2 p-3 rounded-lg ${
//           isRecording 
//             ? "bg-red-500 text-white bg-opacity-70 backdrop-blur-md cursor-pointer hover:bg-opacity-90" 
//             : "bg-red-300 text-white cursor-not-allowed"
//         }`}
//       >
//         <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
//           <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 7.5A2.25 2.25 0 017.5 5.25h9a2.25 2.25 0 012.25 2.25v9a2.25 2.25 0 01-2.25 2.25h-9a2.25 2.25 0 01-2.25-2.25v-9z" />
//         </svg>
//         Stop
//       </button>
      
//       {/* Download button - always visible but only enabled when there's a recording */}
//       <button
//         onClick={recordedVideoUrl ? handleDownload : null}
//         className={`flex items-center gap-2 p-3 rounded-lg ${
//           recordedVideoUrl 
//             ? "bg-green-500 text-white bg-opacity-70 backdrop-blur-md cursor-pointer hover:bg-opacity-90" 
//             : "bg-green-300 text-white cursor-not-allowed"
//         }`}
//       >
//         <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
//           <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
//         </svg>
//         Download
//       </button>
//     </div>
//   );
// };

// export default ContinuousRecorder;



// ContinuousRecorder.jsx
import React, { useState, useRef, useEffect } from 'react';
import { useSpeech } from '../hooks/useSpeech';

const ContinuousRecorder = () => {
  const [isRecording, setIsRecording] = useState(false);
  const [recordedVideoUrl, setRecordedVideoUrl] = useState(null);
  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const audioContextRef = useRef(null);
  const { message, onMessagePlayed } = useSpeech();
  const destinationRef = useRef(null);
  const currentAudioRef = useRef(null);

  const getSupportedMimeType = () => {
    const types = [
      'video/mp4;codecs=h264,aac',
      'video/mp4',
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

      console.log('Using MIME type:', mimeType);

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

      mediaRecorder.onstop = async () => {
        if (chunksRef.current.length === 0) return;

        const blob = new Blob(chunksRef.current, { type: mimeType });
        if (blob.size === 0) return;

        // If the recorded format is not MP4, we'll need to convert it
        if (mimeType.includes('mp4')) {
          const url = URL.createObjectURL(blob);
          setRecordedVideoUrl(url);
        } else {
          // For WebM, we'll still create a URL but note it's not MP4
          const url = URL.createObjectURL(blob);
          setRecordedVideoUrl(url);
          console.warn('Recording is in WebM format. Browser does not support MP4 recording.');
        }
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

  const handleDownload = () => {
    if (recordedVideoUrl) {
      const a = document.createElement('a');
      a.href = recordedVideoUrl;
      
      // Determine file extension based on the MIME type used
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

  // Check if MP4 is supported
  const isMP4Supported = MediaRecorder.isTypeSupported('video/mp4;codecs=h264,aac') || 
                         MediaRecorder.isTypeSupported('video/mp4');

  // Position buttons above the settings button at the bottom
  return (
    <div className="fixed bottom-20 left-4 z-20 flex flex-col gap-2">
      {/* Format indicator */}
      {recordedVideoUrl && (
        <div className="text-xs text-white bg-black bg-opacity-50 px-2 py-1 rounded">
          Format: {isMP4Supported ? 'MP4' : 'WebM'}
        </div>
      )}
      
      {/* Record button at the top */}
      <button 
        onClick={isRecording ? null : startRecording}
        className={`flex items-center gap-2 p-3 rounded-lg ${
          isRecording 
            ? "bg-gray-400 cursor-not-allowed" 
            : "bg-white bg-opacity-70 backdrop-blur-md cursor-pointer hover:bg-opacity-90"
        }`}
      >
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.91 11.672a.375.375 0 010 .656l-5.603 3.113a.375.375 0 01-.557-.328V8.887c0-.286.307-.466.557-.327l5.603 3.112z" />
        </svg>
        Record
      </button>
      
      {/* Stop button - always visible but only enabled when recording */}
      <button 
        onClick={isRecording ? stopRecording : null}
        className={`flex items-center gap-2 p-3 rounded-lg ${
          isRecording 
            ? "bg-red-500 text-white bg-opacity-70 backdrop-blur-md cursor-pointer hover:bg-opacity-90" 
            : "bg-red-300 text-white cursor-not-allowed"
        }`}
      >
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
          <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 7.5A2.25 2.25 0 017.5 5.25h9a2.25 2.25 0 012.25 2.25v9a2.25 2.25 0 01-2.25 2.25h-9a2.25 2.25 0 01-2.25-2.25v-9z" />
        </svg>
        Stop
      </button>
      
      {/* Download button - always visible but only enabled when there's a recording */}
      <button
        onClick={recordedVideoUrl ? handleDownload : null}
        className={`flex items-center gap-2 p-3 rounded-lg ${
          recordedVideoUrl 
            ? "bg-green-500 text-white bg-opacity-70 backdrop-blur-md cursor-pointer hover:bg-opacity-90" 
            : "bg-green-300 text-white cursor-not-allowed"
        }`}
      >
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
        </svg>
        Download {isMP4Supported ? 'MP4' : 'WebM'}
      </button>
    </div>
  );
};

export default ContinuousRecorder;