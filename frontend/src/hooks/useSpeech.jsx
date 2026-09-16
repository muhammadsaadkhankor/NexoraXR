// import { createContext, useContext, useEffect, useState } from "react";

// const backendUrl = "http://localhost:3000";

// const SpeechContext = createContext();

// export const SpeechProvider = ({ children }) => {
//   const [recording, setRecording] = useState(false);
//   const [mediaRecorder, setMediaRecorder] = useState(null);
//   const [messages, setMessages] = useState([]);
//   const [message, setMessage] = useState();
//   const [loading, setLoading] = useState(false);

//   let chunks = [];

//   const initiateRecording = () => {
//     chunks = [];
//   };

//   const onDataAvailable = (e) => {
//     chunks.push(e.data);
//   };

//   const sendAudioData = async (audioBlob) => {
//     const reader = new FileReader();
//     reader.readAsDataURL(audioBlob);
//     reader.onloadend = async function () {
//       const base64Audio = reader.result.split(",")[1];
//       setLoading(true);
//       try {
//         const data = await fetch(`${backendUrl}/sts`, {
//           method: "POST",
//           headers: {
//             "Content-Type": "application/json",
//           },
//           body: JSON.stringify({ audio: base64Audio }),
//         });
//         const response = (await data.json()).messages;
//         setMessages((messages) => [...messages, ...response]);
//       } catch (error) {
//         console.error(error);
//       } finally {
//         setLoading(false);
//       }
//     };
//   };

//   useEffect(() => {
//     if (typeof window !== "undefined") {
//       navigator.mediaDevices
//         .getUserMedia({ audio: true })
//         .then((stream) => {
//           const newMediaRecorder = new MediaRecorder(stream);
//           newMediaRecorder.onstart = initiateRecording;
//           newMediaRecorder.ondataavailable = onDataAvailable;
//           newMediaRecorder.onstop = async () => {
//             const audioBlob = new Blob(chunks, { type: "audio/webm" });
//             try {
//               await sendAudioData(audioBlob);
//             } catch (error) {
//               console.error(error);
//               alert(error.message);
//             }
//           };
//           setMediaRecorder(newMediaRecorder);
//         })
//         .catch((err) => console.error("Error accessing microphone:", err));
//     }
//   }, []);

//   const startRecording = () => {
//     if (mediaRecorder) {
//       mediaRecorder.start();
//       setRecording(true);
//     }
//   };

//   const stopRecording = () => {
//     if (mediaRecorder) {
//       mediaRecorder.stop();
//       setRecording(false);
//     }
//   };

//   const tts = async (message) => {
//     setLoading(true);
//     try {
//       const data = await fetch(`${backendUrl}/tts`, {
//         method: "POST",
//         headers: {
//           "Content-Type": "application/json",
//         },
//         body: JSON.stringify({ message }),
//       });
//       const response = (await data.json()).messages;
//       setMessages((messages) => [...messages, ...response]);
//     } catch (error) {
//       console.error(error);
//     } finally {
//       setLoading(false);
//     }
//   };

//   const onMessagePlayed = () => {
//     setMessages((messages) => messages.slice(1));
//   };

//   useEffect(() => {
//     if (messages.length > 0) {
//       setMessage(messages[0]);
//     } else {
//       setMessage(null);
//     }
//   }, [messages]);

//   return (
//     <SpeechContext.Provider
//       value={{
//         startRecording,
//         stopRecording,
//         recording,
//         tts,
//         message,
//         onMessagePlayed,
//         loading,
//       }}
//     >
//       {children}
//     </SpeechContext.Provider>
//   );
// };

// export const useSpeech = () => {
//   const context = useContext(SpeechContext);
//   if (!context) {
//     throw new Error("useSpeech must be used within a SpeechProvider");
//   }
//   return context;
// };






import { createContext, useContext, useCallback, useEffect, useState, useRef } from "react";

const backendUrl = "http://localhost:3000";

const SpeechContext = createContext();

export const SpeechProvider = ({ children }) => {
  const [recording, setRecording] = useState(false);
  const [mediaRecorder, setMediaRecorder] = useState(null);
  const [messages, setMessages] = useState([]);
  const [message, setMessage] = useState();
  const [loading, setLoading] = useState(false);
  const [micPermissionGranted, setMicPermissionGranted] = useState(false);
  const chunksRef = useRef([]);
  const latestAudioBlobRef = useRef(null);
  const recognitionRef = useRef(null);
  const [speechSupported, setSpeechSupported] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const transcriptPromiseRef = useRef(null);

  // Initialize Web Speech API
  useEffect(() => {
    if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      const recognition = new SpeechRecognition();
      
      recognition.continuous = false;
      recognition.interimResults = false;
      recognition.lang = 'en-US'; // Force English
      recognition.maxAlternatives = 1;
      
      recognitionRef.current = recognition;
      setSpeechSupported(true);
      
      console.log('Speech Recognition initialized');
    } else {
      console.warn('Speech Recognition not supported in this browser');
      setSpeechSupported(false);
    }
  }, []);

  const initiateRecording = () => {
    chunksRef.current = [];
  };

  const onDataAvailable = (e) => {
    if (e.data.size > 0) {
      chunksRef.current.push(e.data);
    }
  };

  // Updated transcribeAudio to work with press and hold pattern
  const transcribeAudio = async () => {
    if (!speechSupported || !recognitionRef.current) {
      console.error("Speech recognition not supported");
      return "";
    }

    // Return the existing promise if already transcribing
    if (transcriptPromiseRef.current) {
      return transcriptPromiseRef.current;
    }

    transcriptPromiseRef.current = new Promise((resolve, reject) => {
      const recognition = recognitionRef.current;
      
      // Clear any existing event listeners
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      recognition.onstart = null;
      
      recognition.onstart = () => {
        console.log('Speech recognition started');
        setIsListening(true);
      };
      
      recognition.onresult = (event) => {
        const transcript = event.results[0][0].transcript;
        console.log('Transcribed:', transcript);
        setIsListening(false);
        transcriptPromiseRef.current = null;
        resolve(transcript);
      };
      
      recognition.onerror = (event) => {
        console.error('Speech recognition error:', event.error);
        setIsListening(false);
        transcriptPromiseRef.current = null;
        
        if (event.error === 'no-speech') {
          resolve(""); // Return empty string instead of error for no speech
        } else {
          reject(new Error(`Speech recognition failed: ${event.error}`));
        }
      };
      
      recognition.onend = () => {
        console.log('Speech recognition ended');
        setIsListening(false);
        // If we haven't resolved yet, it means no speech was detected
        if (transcriptPromiseRef.current) {
          transcriptPromiseRef.current = null;
          resolve("");
        }
      };
      
      try {
        recognition.start();
      } catch (error) {
        console.error('Error starting speech recognition:', error);
        setIsListening(false);
        transcriptPromiseRef.current = null;
        reject(error);
      }
    });

    return transcriptPromiseRef.current;
  };

  const pushMessage = useCallback((msg, fromRemote = false) => {
    const id = msg.id || (Math.random().toString(36).slice(2) + Date.now().toString(36));
    const messageWithMeta = { ...msg, id, fromRemote };
    setMessages((prev) => {
      if (prev.some((m) => m.id === id)) return prev;
      return [...prev, messageWithMeta];
    });
  }, []);

  const sendAudioData = async (audioBlob) => {
    const reader = new FileReader();
    reader.readAsDataURL(audioBlob);
    reader.onloadend = async function () {
      const base64Audio = reader.result.split(",")[1];
      setLoading(true);
      try {
        const data = await fetch(`${backendUrl}/sts`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ audio: base64Audio }),
        });
        const response = (await data.json()).messages;
        response.forEach((msg) => pushMessage(msg, false));
      } catch (error) {
        console.error(error);
      } finally {
        setLoading(false);
      }
    };
  };

  useEffect(() => {
    if (typeof window !== "undefined") {
      navigator.mediaDevices
        .getUserMedia({ audio: true })
        .then((stream) => {
          setMicPermissionGranted(true);
          const newMediaRecorder = new MediaRecorder(stream, {
            mimeType: 'audio/webm;codecs=opus'
          });
          newMediaRecorder.onstart = initiateRecording;
          newMediaRecorder.ondataavailable = onDataAvailable;
          newMediaRecorder.onstop = async () => {
            if (chunksRef.current.length > 0) {
              const audioBlob = new Blob(chunksRef.current, { type: "audio/webm" });
              latestAudioBlobRef.current = audioBlob;
            }
          };
          setMediaRecorder(newMediaRecorder);
        })
        .catch((err) => {
          console.error("Error accessing microphone:", err);
          alert("Please allow microphone access to use this feature");
        });
    }
  }, []);

  const startRecording = () => {
    console.log('Starting recording...');
    setRecording(true);
    
    if (speechSupported && recognitionRef.current) {
      // Start speech recognition immediately
      transcribeAudio().catch(error => {
        console.error('Speech recognition failed:', error);
      });
    }
  };

  const stopRecording = () => {
    console.log('Stopping recording...');
    setRecording(false);
    
    if (speechSupported && recognitionRef.current && isListening) {
      try {
        recognitionRef.current.stop();
      } catch (error) {
        console.error('Error stopping recognition:', error);
      }
    }
  };

  const tts = async (message) => {
    if (!message || message.trim() === "") return;
    
    setLoading(true);
    try {
      const data = await fetch(`${backendUrl}/tts`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ message }),
      });
      const response = (await data.json()).messages;
      response.forEach((msg) => pushMessage(msg, false));
    } catch (error) {
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  const onMessagePlayed = () => {
    setMessages((messages) => messages.slice(1));
  };

  useEffect(() => {
    if (messages.length > 0) {
      setMessage(messages[0]);
    } else {
      setMessage(null);
    }
  }, [messages]);

  return (
    <SpeechContext.Provider
      value={{
        startRecording,
        stopRecording,
        recording,
        tts,
        message,
        pushMessage,
        onMessagePlayed,
        loading,
        transcribeAudio,
        micPermissionGranted,
        speechSupported,
        isListening,
      }}
    >
      {children}
    </SpeechContext.Provider>
  );
};

export const useSpeech = () => {
  const context = useContext(SpeechContext);
  if (!context) {
    throw new Error("useSpeech must be used within a SpeechProvider");
  }
  return context;
};