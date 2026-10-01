import { createContext, useContext, useCallback, useEffect, useState, useRef } from "react";
import { API_URL } from "../config";

const backendUrl = API_URL;

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
  const hasRequestedMicRef = useRef(false);
  const recognitionRef = useRef(null);
  const [speechSupported, setSpeechSupported] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const transcriptPromiseRef = useRef(null);
  const audioElementRef = useRef(null);
  const messageRef = useRef(null);
  messageRef.current = message;
  const floorPausedRef = useRef(false);
  const [floorPaused, setFloorPaused] = useState(false);

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

  const requestMicrophoneAccess = async () => {
    if (typeof window === "undefined" || hasRequestedMicRef.current) return;

    hasRequestedMicRef.current = true;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
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
    } catch (err) {
      console.error("Error accessing microphone:", err);
      alert("Please allow microphone access to use this feature");
      throw err;
    }
  };

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

  const prependMessages = useCallback((msgs) => {
    const prepared = (msgs || []).map((m) => ({
      ...m,
      id: m.id || (Math.random().toString(36).slice(2) + Date.now().toString(36)),
      fromRemote: m.fromRemote ?? false,
    }));
    setMessages((prev) => {
      const existing = new Set(prev.map((m) => m.id));
      return [...prepared.filter((m) => !existing.has(m.id)), ...prev];
    });
  }, []);

  // Pause the currently-playing lecture segment in place for the floor owner.
  // Stamps resumeAt on the lecture message so it can restart from the same
  // point after the floor is released or an answer finishes playing.
  const pauseLectureForFloor = useCallback(() => {
    const audio = audioElementRef.current;
    const current = messageRef.current;
    if (current?.type !== 'lecture') return;
    floorPausedRef.current = true;
    setFloorPaused(true);
    if (audio) {
      current.resumeAt = audio.currentTime;
      audio.pause();
      console.log('[FLOOR_PAUSE]', `messageId=${current.id}`, `audioTime=${audio.currentTime.toFixed(2)}`);
    }
  }, []);

  // Resume a floor-paused lecture segment from its paused position.
  const resumeLecture = useCallback(() => {
    floorPausedRef.current = false;
    setFloorPaused(false);
    const audio = audioElementRef.current;
    const current = messageRef.current;
    // `!audio.ended` guards against replaying a stale/finished element (e.g. an
    // answer audio whose ref hasn't been swapped for the lecture audio yet).
    if (current?.type === 'lecture' && audio && audio.paused && !audio.ended) {
      audio.play().catch(() => {});
      console.log('[LECTURE_RESUME]', `messageId=${current.id}`, `currentTime=${audio.currentTime.toFixed(2)}`);
    }
  }, []);

  // Interrupt the currently-playing lecture segment with a question.
  // Pauses the audio, stamps resumeAt on the lecture message so the
  // segment restarts from the same point, then prepends the answer
  // ahead of the remaining lecture queue.
  const askQuestion = async (question, lectureId) => {
    if (!question || question.trim() === "") return;
    const audio = audioElementRef.current;
    const current = message;
    if (current?.type === 'lecture' && audio) {
      current.resumeAt = audio.currentTime;
      audio.pause();
      // Same as a floor pause: the professor must idle while "thinking".
      floorPausedRef.current = true;
      setFloorPaused(true);
    }
    setLoading(true);
    try {
      const data = await fetch(`${backendUrl}/api/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, lectureId }),
      });
      const response = (await data.json()).messages;
      if (!response || response.length === 0) {
        throw new Error('Empty answer');
      }
      prependMessages(response.map((m) => ({
        ...m,
        audioUrl: m.audioUrl && m.audioUrl.startsWith('/') ? `${backendUrl}${m.audioUrl}` : m.audioUrl,
      })));
    } catch (error) {
      console.error(error);
      if (current) delete current.resumeAt;
      if (audio && audio.paused) audio.play().catch(() => {});
    } finally {
      // The queued answer now owns the head of the queue (or the lecture is
      // resuming after a failure) — clear the listening/idle state either way.
      floorPausedRef.current = false;
      setFloorPaused(false);
      setLoading(false);
    }
  };

  const clearMessages = useCallback(() => {
    floorPausedRef.current = false;
    setFloorPaused(false);
    setMessages([]);
    setMessage(null);
  }, []);

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
        messages,
        pushMessage,
        onMessagePlayed,
        clearMessages,
        loading,
        transcribeAudio,
        micPermissionGranted,
        speechSupported,
        isListening,
        requestMicrophoneAccess,
        audioElementRef,
        askQuestion,
        prependMessages,
        pauseLectureForFloor,
        resumeLecture,
        floorPausedRef,
        floorPaused,
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