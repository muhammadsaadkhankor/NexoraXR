// import { useRef } from "react";
// import { useSpeech } from "../hooks/useSpeech";

// export const ChatInterface = ({ hidden, ...props }) => {
//   const input = useRef();
//   const { tts, loading, message, startRecording, stopRecording, recording } = useSpeech();

//   const sendMessage = async () => {
//     const text = input.current.value;
//     if (!loading && !message) {
//       try {
//         await tts(text);
//         input.current.value = "";
//       } catch (error) {
//         console.error('Error sending message:', error);
//         // Handle error in UI if needed
//       }
//     }
//   };
//   if (hidden) {
//     return null;
//   }

//   return (
//     <div className="fixed top-0 left-0 right-0 bottom-0 z-10 flex justify-between p-4 flex-col pointer-events-none">
//       <div className="self-start backdrop-blur-md bg-white bg-opacity-50 p-4 rounded-lg">
//         <h1 className="font-black text-xl text-gray-700">Digital Twin</h1>
//         <p className="text-gray-600">
//           {loading ? "Loading..." : "Type a message and press enter to chat with the AI."}
//         </p>
//       </div>
//       <div className="w-full flex flex-col items-end justify-center gap-4"></div>
//       <div className="flex items-center gap-2 pointer-events-auto max-w-screen-sm w-full mx-auto">
//         <button
//           onClick={recording ? stopRecording : startRecording}
//           className={`bg-gray-500 hover:bg-gray-600 text-white p-4 px-4 font-semibold uppercase rounded-md ${
//             recording ? "bg-red-500 hover:bg-red-600" : ""
//           } ${loading || message ? "cursor-not-allowed opacity-30" : ""}`}
//         >
//           <svg
//             xmlns="http://www.w3.org/2000/svg"
//             fill="none"
//             viewBox="0 0 24 24"
//             strokeWidth={1.5}
//             stroke="currentColor"
//             className="w-6 h-6"
//           >
//             <path
//               strokeLinecap="round"
//               strokeLinejoin="round"
//               d="M12 18.75a6 6 0 0 0 6-6v-1.5m-6 7.5a6 6 0 0 1-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 0 1-3-3V4.5a3 3 0 1 1 6 0v8.25a3 3 0 0 1-3 3Z"
//             />
//           </svg>
//         </button>

//         <input
//           className="w-full placeholder:text-gray-800 placeholder:italic p-4 rounded-md bg-opacity-50 bg-white backdrop-blur-md"
//           placeholder="Type a message..."
//           ref={input}
//           onKeyDown={(e) => {
//             if (e.key === "Enter") {
//               sendMessage();
//             }
//           }}
//         />
//         <button
//           disabled={loading || message}
//           onClick={sendMessage}
//           className={`bg-gray-500 hover:bg-gray-600 text-white p-4 px-10 font-semibold uppercase rounded-md ${
//             loading || message ? "cursor-not-allowed opacity-30" : ""
//           }`}
//         >
//           Send
//         </button>
//       </div>
//     </div>
//   );
// };


import { useRef, useState, useEffect } from "react";
import { useSpeech } from "../hooks/useSpeech";

export const ChatInterface = ({ hidden, ...props }) => {
  const input = useRef();
  const [isTranscribing, setIsTranscribing] = useState(false);
  const { tts, loading, message, startRecording, stopRecording, recording, transcribeAudio, micPermissionGranted, speechSupported, isListening } = useSpeech();
  // Remove autoSend state since it's not needed
  const [isPressed, setIsPressed] = useState(false);
  const currentTranscriptionRef = useRef(null);

  const sendMessage = async () => {
    const text = input.current.value;
    if (!loading && !message && text.trim()) {
      try {
        await tts(text);
        input.current.value = "";
      } catch (error) {
        console.error('Error sending message:', error);
      }
    }
  };

  const handleMicPress = async () => {
    if (!loading && !message && speechSupported && !isPressed) {
      console.log('Mic pressed - starting recording');
      setIsPressed(true);
      setIsTranscribing(true);
      startRecording();
      
      // Start transcription process
      currentTranscriptionRef.current = transcribeAudio();
    }
  };

  const handleMicRelease = async () => {
    if (isPressed) {
      console.log('Mic released - stopping recording');
      setIsPressed(false);
      stopRecording();
      
      try {
        // Wait for the transcription to complete
        const transcript = await currentTranscriptionRef.current;
        setIsTranscribing(false);
        
        console.log('Received transcript:', transcript);
        
        if (transcript && transcript.trim() && input.current) {
          input.current.value = transcript;
          input.current.focus();
          
          // Remove auto-send functionality
        }
      } catch (error) {
        console.error('Transcription error:', error);
        setIsTranscribing(false);
      } finally {
        currentTranscriptionRef.current = null;
      }
    }
  };

  // Handle mouse events
  const handleMouseDown = (e) => {
    e.preventDefault();
    handleMicPress();
  };

  const handleMouseUp = (e) => {
    e.preventDefault();
    handleMicRelease();
  };

  const handleMouseLeave = (e) => {
    // Stop recording if mouse leaves the button while pressed
    if (isPressed) {
      handleMicRelease();
    }
  };

  // Handle touch events for mobile
  const handleTouchStart = (e) => {
    e.preventDefault();
    handleMicPress();
  };

  const handleTouchEnd = (e) => {
    e.preventDefault();
    handleMicRelease();
  };

  // Handle keyboard events (spacebar)
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.code === 'Space' && !isPressed && !loading && !message && speechSupported) {
        e.preventDefault();
        handleMicPress();
      }
    };

    const handleKeyUp = (e) => {
      if (e.code === 'Space' && isPressed) {
        e.preventDefault();
        handleMicRelease();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [isPressed, loading, message, speechSupported]);

  // Cleanup if component unmounts while recording
  useEffect(() => {
    return () => {
      if (isPressed) {
        stopRecording();
      }
    };
  }, []);

  if (hidden) {
    return null;
  }

  return (
    <div className="fixed top-0 left-0 right-0 bottom-0 z-10 flex justify-between p-4 flex-col pointer-events-none">
      <div className="self-start backdrop-blur-md bg-white bg-opacity-50 p-4 rounded-lg">
        <h1 className="font-black text-xl text-gray-700">Digital Twin</h1>
        <p className="text-gray-600">
          {loading 
            ? "Loading..." 
            : isTranscribing || isListening 
              ? "Listening... (Release to stop)" 
              : "Type a message or hold the mic button to record."
          }
        </p>
        {!speechSupported && (
          <p className="text-red-600 text-sm mt-1">
            Speech recognition not supported in this browser. Please use Chrome, Edge, or Safari.
          </p>
        )}
        {/* Remove the auto-send toggle section */}
        <div className="mt-2 text-xs text-gray-500">
          💡 Tip: Hold Spacebar to record from anywhere
        </div>
      </div>
      
      <div className="w-full flex flex-col items-end justify-center gap-4"></div>
      <div className="flex items-center gap-2 pointer-events-auto max-w-screen-sm w-full mx-auto">
        <button
          onMouseDown={handleMouseDown}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseLeave}
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
          className={`mic-button bg-gray-500 hover:bg-gray-600 text-white p-4 px-4 font-semibold uppercase rounded-md transition-colors select-none ${
            isPressed || isTranscribing || isListening ? "bg-red-500 hover:bg-red-600 animate-pulse scale-110" : ""
          } ${loading || message || !speechSupported ? "cursor-not-allowed opacity-30" : "cursor-pointer"}`}
          disabled={loading || message || !speechSupported}
          style={{ 
            userSelect: 'none',
            WebkitUserSelect: 'none',
            MozUserSelect: 'none',
            msUserSelect: 'none'
          }}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={1.5}
            stroke="currentColor"
            className="w-6 h-6"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 18.75a6 6 0 0 0 6-6v-1.5m-6 7.5a6 6 0 0 1-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 0 1-3-3V4.5a3 3 0 1 1 6 0v8.25a3 3 0 0 1-3 3Z"
            />
          </svg>
        </button>

        <input
          className="w-full placeholder:text-gray-800 placeholder:italic p-4 rounded-md bg-opacity-50 bg-white backdrop-blur-md"
          placeholder="Type a message or hold mic to record..."
          ref={input}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              sendMessage();
            }
          }}
        />
        <button
          disabled={loading || message}
          onClick={sendMessage}
          className={`bg-gray-500 hover:bg-gray-600 text-white p-4 px-10 font-semibold uppercase rounded-md ${
            loading || message ? "cursor-not-allowed opacity-30" : ""
          }`}
        >
          Send
        </button>
      </div>
    </div>
  );
};