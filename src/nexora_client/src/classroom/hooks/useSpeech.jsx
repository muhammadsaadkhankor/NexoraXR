import { createContext, useContext, useCallback, useEffect, useState, useRef } from "react";
import { API_URL } from "../../shared/config";
import { resolveResume } from "../services/ncipResume";

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
  const messagesRef = useRef([]);
  messagesRef.current = messages;
  const floorPausedRef = useRef(false);
  const [floorPaused, setFloorPaused] = useState(false);
  // Set by the socket owner (Scene) — invoked with the floor-answer message
  // when its audio finishes so the client can report answer-ended to the
  // server (NCIP answer.end).
  const answerEndedRef = useRef(null);
  const reportedAnswerEndsRef = useRef(new Set());

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

  const startRecording = async () => {
    console.log('Starting recording...');
    setRecording(true);

    // Lazy mic acquisition: only when the user actually initiates recording.
    if (!micPermissionGranted) {
      try {
        await requestMicrophoneAccess();
      } catch {
        return;
      }
    }

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
    setMessages((messages) => {
      const played = messages[0];
      if (played?.floorAnswer && !reportedAnswerEndsRef.current.has(played.id)) {
        reportedAnswerEndsRef.current.add(played.id);
        answerEndedRef.current?.(played);
      }
      return messages.slice(1);
    });
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

  // Replace the entire queue (including the head). Used by mid-lecture
  // language switching when the head itself is the lecture segment that
  // must restart in the new language — caller pauses the audio element.
  const replaceQueue = useCallback((msgs) => {
    const prepared = (msgs || []).map((m) => ({
      ...m,
      id: m.id || (Math.random().toString(36).slice(2) + Date.now().toString(36)),
      fromRemote: m.fromRemote ?? false,
    }));
    setMessages(prepared);
  }, []);

  // Replace everything after the currently-playing message (messages[0]).
  // Used by mid-lecture language switching while a floor answer is playing:
  // the answer finishes, and all queued lecture segments come from the
  // new-language manifest. If nothing is queued, the whole queue is replaced.
  const replacePending = useCallback((msgs) => {
    const prepared = (msgs || []).map((m) => ({
      ...m,
      id: m.id || (Math.random().toString(36).slice(2) + Date.now().toString(36)),
      fromRemote: m.fromRemote ?? false,
    }));
    setMessages((prev) => (prev.length ? [prev[0], ...prepared] : prepared));
  }, []);

  // Pause the currently-playing lecture segment in place for the floor owner.
  // Stamps resumeAt on the lecture message so it can restart from the same
  // point after the floor is released or an answer finishes playing.
  // Returns the interruption checkpoint ({ segmentIndex, playbackOffsetMs })
  // for the caller to report to the server, or null if no lecture is playing.
  const pauseLectureForFloor = useCallback(() => {
    const audio = audioElementRef.current;
    const current = messageRef.current;
    if (current?.type !== 'lecture') return null;
    floorPausedRef.current = true;
    setFloorPaused(true);
    if (audio) {
      current.resumeAt = audio.currentTime;
      audio.pause();
      console.log('[FLOOR_PAUSE]', `messageId=${current.id}`, `audioTime=${audio.currentTime.toFixed(2)}`);
    }
    const segMatch = /_seg_(\d+)$/.exec(current.id || '');
    return {
      segmentIndex: segMatch ? Number(segMatch[1]) : null,
      playbackOffsetMs: audio ? Math.round(audio.currentTime * 1000) : 0,
    };
  }, []);

  // Resume a floor-paused lecture. When the server supplies a canonical
  // checkpoint {lectureId, segmentIndex, playbackOffsetMs, language}, that is
  // the authoritative resume target for every client; the local resumeAt is
  // only a fallback for local/legacy playback or unmappable checkpoints.
  const resumeLecture = useCallback((checkpoint) => {
    floorPausedRef.current = false;
    setFloorPaused(false);
    const msgs = messagesRef.current;
    const audio = audioElementRef.current;
    const plan = resolveResume(msgs, checkpoint);

    switch (plan.action) {
      case 'seek-head': {
        const target = msgs[0];
        if (plan.offsetSec > 0) target.resumeAt = plan.offsetSec;
        else delete target.resumeAt;
        // `!audio.ended` guards against replaying a stale/finished element
        // (e.g. an answer audio whose ref hasn't been swapped yet).
        if (audio && !audio.ended) {
          try { audio.currentTime = plan.offsetSec; } catch (e) {
            console.error('[LECTURE_RESUME] seek failed:', e);
          }
          if (audio.paused) audio.play().catch(() => {});
          console.log('[LECTURE_RESUME]', `messageId=${target.id}`, `serverOffset=${plan.offsetSec.toFixed(2)}s`);
        }
        break;
      }
      case 'trim-and-seek': {
        const target = msgs[plan.fromIndex];
        if (plan.offsetSec > 0) target.resumeAt = plan.offsetSec;
        else delete target.resumeAt;
        console.log('[LECTURE_RESUME]', `trim to ${target.id}`, `serverOffset=${plan.offsetSec.toFixed(2)}s`);
        setMessages(msgs.slice(plan.fromIndex));
        break;
      }
      case 'local-fallback': {
        if (plan.reason) {
          console.error('[LECTURE_RESUME] server checkpoint unusable, falling back to local resumeAt:', plan);
        }
        const current = msgs[0];
        if (current?.type === 'lecture' && audio && audio.paused && !audio.ended) {
          audio.play().catch(() => {});
          console.log('[LECTURE_RESUME]', `messageId=${current.id}`, `currentTime=${audio.currentTime.toFixed(2)}`);
        }
        break;
      }
      default:
        console.error('[LECTURE_RESUME] cannot resume:', plan);
    }
  }, []);

  // Hard-stop the current audio element when its message is being DISCARDED
  // (language-switch rebuild). Detaches onended/onerror first so a terminal
  // event can't fire between pause and queue replacement and pop the new
  // head — that race skipped segments / left a stale head. NOT used by the
  // floor-pause paths, where the same element is reused on resume and needs
  // its 'ended' handler intact.
  const stopAudio = useCallback(() => {
    const a = audioElementRef.current;
    if (!a) return;
    a.onended = null;
    a.onerror = null;
    a.pause();
    audioElementRef.current = null;
  }, []);

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
        replacePending,
        replaceQueue,
        loading,
        transcribeAudio,
        micPermissionGranted,
        speechSupported,
        isListening,
        requestMicrophoneAccess,
        audioElementRef,
        stopAudio,
        prependMessages,
        pauseLectureForFloor,
        resumeLecture,
        floorPausedRef,
        floorPaused,
        setFloorPaused,
        answerEndedRef,
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