import { useRef, useState, useEffect } from "react";
import { useSpeech } from "../hooks/useSpeech";
import { SpeakingTranscript } from "./SpeakingTranscript";
import { Mic, Send, Bot, User, Trash2, Maximize2, Minus, MoreHorizontal } from "lucide-react";

export const ChatInterface = ({ hidden, onMinimize, lectureId, floorHolder, isFloorHolder, floorAnswering, floorError, onFloorQuestion, ...props }) => {
  const input = useRef();
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [chatHistory, setChatHistory] = useState([
    {
      role: "assistant",
      text: "Hello! I'm LeProf, your Multimedia course assistant. How can I help you today?",
      time: new Date(),
    },
  ]);
  const [isPressed, setIsPressed] = useState(false);
  const currentTranscriptionRef = useRef(null);

  const { tts, loading, message, startRecording, stopRecording, recording, transcribeAudio, micPermissionGranted, speechSupported, isListening, audioElementRef } = useSpeech();
  const [lectureLine, setLectureLine] = useState(null);
  const messagesEndRef = useRef(null);

  useEffect(() => {
    if (!message || !message.text) return;
    if (message.type === 'lecture') {
      setLectureLine({ id: message.id, text: message.text, time: new Date() });
      return;
    }
    setChatHistory((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.role === "assistant" && last.text === message.text) return prev;
      return [...prev, { role: "assistant", text: message.text, time: new Date() }];
    });
  }, [message]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatHistory, lectureLine]);

  const sendMessage = async () => {
    const text = input.current.value;
    if (!text.trim()) return;

    // One authoritative protocol path (NCIP): during a lecture — or while
    // anyone holds the floor — questions go through the floor socket flow.
    // Non-holders are blocked while the floor is taken; submitting without
    // the floor raises a hand first and the question is sent on grant.
    const interruptingLecture = message?.type === 'lecture';
    if (floorHolder || interruptingLecture) {
      if ((floorHolder && !isFloorHolder) || floorAnswering || loading) return;
      setChatHistory((prev) => [...prev, { role: "user", text, time: new Date() }]);
      input.current.value = "";
      onFloorQuestion?.(text);
      return;
    }

    // No lecture in progress — free-form chat with the professor.
    if (!loading && !message) {
      setChatHistory((prev) => [...prev, { role: "user", text, time: new Date() }]);
      input.current.value = "";
      try {
        await tts(text);
      } catch (error) {
        console.error("Error sending message:", error);
      }
    }
  };

  const handleMicPress = async () => {
    if (!loading && (!message || message.type === 'lecture') && speechSupported && !isPressed) {
      setIsPressed(true);
      setIsTranscribing(true);
      startRecording();
      currentTranscriptionRef.current = transcribeAudio();
    }
  };

  const handleMicRelease = async () => {
    if (isPressed) {
      setIsPressed(false);
      stopRecording();

      try {
        const transcript = await currentTranscriptionRef.current;
        setIsTranscribing(false);

        if (transcript && transcript.trim() && input.current) {
          input.current.value = transcript;
        }
      } catch (error) {
        console.error("Transcription error:", error);
        setIsTranscribing(false);
      } finally {
        currentTranscriptionRef.current = null;
      }
    }
  };

  const handleMouseDown = (e) => {
    e.preventDefault();
    handleMicPress();
  };

  const handleMouseUp = (e) => {
    e.preventDefault();
    handleMicRelease();
  };

  const handleMouseLeave = (e) => {
    if (isPressed) {
      handleMicRelease();
    }
  };

  const handleTouchStart = (e) => {
    e.preventDefault();
    handleMicPress();
  };

  const handleTouchEnd = (e) => {
    e.preventDefault();
    handleMicRelease();
  };

  useEffect(() => {
    const handleKeyDown = (e) => {
      // Space is reserved for the user avatar jump
    };

    const handleKeyUp = (e) => {};

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, [isPressed, loading, message, speechSupported]);

  useEffect(() => {
    return () => {
      if (isPressed) {
        stopRecording();
      }
    };
  }, []);

  const floorBlocked = !!floorHolder && !isFloorHolder;
  const floorSendBlocked = !!floorHolder && (!isFloorHolder || floorAnswering || loading);

  const formatTime = (date) =>
    date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  return (
    <div
      className={`fixed bottom-0 left-0 right-0 z-50 transition-all duration-300 ease-out ${
        hidden
          ? "translate-y-full opacity-0 pointer-events-none"
          : "translate-y-0 opacity-100 pointer-events-auto"
      }`}
      {...props}
    >
      <div className="mx-auto w-full max-w-5xl bg-slate-900/95 rounded-t-3xl shadow-2xl flex flex-col max-h-[30vh]">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-slate-700/50">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-slate-700 flex items-center justify-center text-white">
              <Bot size={20} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="font-semibold text-white text-lg">LeProf</h1>
                <span className="w-2 h-2 rounded-full bg-green-500" />
              </div>
              <p className="text-xs text-slate-400">Multimedia Course Assistant</p>
            </div>
          </div>

          <div className="flex items-center gap-1 text-slate-400">
            <button className="p-2 hover:bg-slate-800 rounded-lg transition-colors" title="Clear chat" onClick={() => setChatHistory([])}>
              <Trash2 size={18} />
            </button>
            <button className="p-2 hover:bg-slate-800 rounded-lg transition-colors" title="Maximize">
              <Maximize2 size={18} />
            </button>
            <button onClick={onMinimize} className="p-2 hover:bg-slate-800 rounded-lg transition-colors" title="Minimize">
              <Minus size={18} />
            </button>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {chatHistory.map((msg, i) => (
            <div
              key={i}
              className={`flex items-end gap-3 ${msg.role === "user" ? "flex-row-reverse" : ""}`}
            >
              {msg.role === "assistant" && (
                <div className="w-8 h-8 rounded-full bg-slate-700 flex-shrink-0 flex items-center justify-center text-white">
                  <Bot size={14} />
                </div>
              )}
              {msg.role === "user" && (
                <div className="w-8 h-8 rounded-full bg-blue-600 flex-shrink-0 flex items-center justify-center text-white">
                  <User size={14} />
                </div>
              )}

              <div
                className={`max-w-[80%] p-3 rounded-2xl text-sm leading-relaxed ${
                  msg.role === "user"
                    ? "bg-blue-600 text-white rounded-tr-none"
                    : "bg-slate-800 text-slate-100 rounded-tl-none"
                }`}
              >
                {msg.text}
                <div
                  className={`text-[10px] mt-1 ${
                    msg.role === "user" ? "text-blue-200" : "text-slate-500"
                  }`}
                >
                  {formatTime(msg.time)}
                </div>
              </div>
            </div>
          ))}

          {lectureLine && (!message || message.type === 'lecture') && (
            <div className="flex items-end gap-3">
              <div className="w-8 h-8 rounded-full bg-slate-700 flex-shrink-0 flex items-center justify-center text-white">
                <Bot size={14} />
              </div>
              <div className="max-w-[80%] p-3 rounded-2xl rounded-tl-none text-sm leading-relaxed bg-slate-800 text-slate-100 ring-1 ring-cyan-500/40">
                <div className="text-[10px] mb-1 font-semibold text-cyan-300 uppercase tracking-wide">
                  Now speaking
                </div>
                <SpeakingTranscript
                  key={lectureLine.id}
                  text={lectureLine.text}
                  audioRef={audioElementRef}
                />
                <div className="text-[10px] mt-1 text-slate-500">
                  {formatTime(lectureLine.time)}
                </div>
              </div>
            </div>
          )}

          {(loading || isTranscribing || isListening) && (
            <div className="flex items-start gap-3">
              <div className="w-8 h-8 rounded-full bg-slate-700 flex items-center justify-center text-white">
                <Bot size={14} />
              </div>
              <div className="bg-slate-800 text-slate-300 p-3 rounded-2xl rounded-tl-none text-sm">
                {isListening || isTranscribing ? "Listening..." : "LeProf is thinking..."}
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <div className="p-4 border-t border-slate-700/50">
          {floorHolder && (
            <p className="mb-2 text-xs text-slate-400">
              {isFloorHolder
                ? floorAnswering
                  ? "Professor is preparing an answer..."
                  : "You have the floor — ask your question."
                : `${floorHolder.name} has the floor`}
            </p>
          )}
          {floorError && <p className="mb-2 text-xs text-red-300">{floorError}</p>}
          <div className="flex items-center gap-2 bg-slate-800 rounded-full px-2 py-2">
            <button
              onMouseDown={handleMouseDown}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseLeave}
              onTouchStart={handleTouchStart}
              onTouchEnd={handleTouchEnd}
              className={`w-10 h-10 rounded-full flex items-center justify-center text-white transition-colors select-none ${
                isPressed || isTranscribing || isListening
                  ? "bg-red-500 hover:bg-red-600 animate-pulse"
                  : "bg-slate-700 hover:bg-slate-600"
              } ${floorSendBlocked || loading || (message && message.type !== 'lecture') || !speechSupported ? "cursor-not-allowed opacity-30" : "cursor-pointer"}`}
              disabled={floorSendBlocked || loading || (message && message.type !== 'lecture') || !speechSupported}
              style={{
                userSelect: "none",
                WebkitUserSelect: "none",
              }}
            >
              <Mic size={18} />
            </button>

            <input
              className="flex-1 bg-transparent text-white placeholder-slate-400 text-sm px-2 outline-none disabled:opacity-50"
              placeholder={floorBlocked ? `${floorHolder.name} has the floor...` : "Type your message to LeProf..."}
              disabled={floorBlocked}
              ref={input}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  sendMessage();
                }
              }}
            />

            <button
              disabled={floorSendBlocked || loading || (message && message.type !== 'lecture')}
              onClick={sendMessage}
              className={`w-10 h-10 rounded-full flex items-center justify-center text-white transition-colors ${
                floorSendBlocked || loading || (message && message.type !== 'lecture') ? "bg-slate-700 cursor-not-allowed opacity-30" : "bg-blue-600 hover:bg-blue-500"
              }`}
            >
              <Send size={18} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
