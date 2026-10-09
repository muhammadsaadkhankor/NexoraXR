import { useCallback, useEffect, useRef, useState } from 'react';

const RTC_CONFIG = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

// Peer-to-peer voice chat for classroom users.
// Signaling rides on the existing Socket.IO 'webrtc-signal' relay; media is a
// WebRTC mesh (one RTCPeerConnection per remote user). Voice is off by default
// — toggling on requests the mic and negotiates with everyone currently in the
// room. Rendered remote audio is positional (see RemoteAvatar).
export function useVoiceChat() {
  const [voiceOn, setVoiceOn] = useState(false);
  const [remoteStreams, setRemoteStreams] = useState({}); // userId -> MediaStream
  const peersRef = useRef(new Map()); // userId -> RTCPeerConnection
  const localStreamRef = useRef(null);
  const socketRef = useRef(null);
  const remotePlayersRef = useRef([]);
  const voiceOnRef = useRef(false);
  voiceOnRef.current = voiceOn;

  const dropPeer = useCallback((userId) => {
    const pc = peersRef.current.get(userId);
    if (pc) {
      try { pc.close(); } catch {}
      peersRef.current.delete(userId);
    }
    setRemoteStreams((prev) => {
      if (!(userId in prev)) return prev;
      const next = { ...prev };
      delete next[userId];
      return next;
    });
  }, []);

  const createPeer = useCallback((userId) => {
    const existing = peersRef.current.get(userId);
    if (existing) return existing;

    const socket = socketRef.current;
    const pc = new RTCPeerConnection(RTC_CONFIG);

    pc.onicecandidate = (e) => {
      if (e.candidate && socket) {
        socket.emit('webrtc-signal', { to: userId, data: { type: 'ice', candidate: e.candidate } });
      }
    };
    pc.ontrack = (e) => {
      const stream = e.streams[0];
      if (!stream) return;
      setRemoteStreams((prev) => (prev[userId] === stream ? prev : { ...prev, [userId]: stream }));
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        dropPeer(userId);
      }
    };

    // Track added while a peer already exists (mic acquired after connecting)
    // → renegotiate automatically.
    pc.onnegotiationneeded = async () => {
      if (pc.signalingState !== 'stable' || !socket) return;
      try {
        await pc.setLocalDescription();
        pc._offerAt = Date.now();
        socket.emit('webrtc-signal', { to: userId, data: { type: 'offer', sdp: pc.localDescription.sdp } });
      } catch (err) {
        console.error('[voice] renegotiation failed:', err);
      }
    };

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => pc.addTrack(t, localStreamRef.current));
    } else {
      pc.addTransceiver('audio', { direction: 'recvonly' });
    }
    peersRef.current.set(userId, pc);
    return pc;
  }, [dropPeer]);

  const callPeer = useCallback(async (userId) => {
    const socket = socketRef.current;
    if (!socket) return;
    const existing = peersRef.current.get(userId);
    if (existing && existing.localDescription) return; // offer already sent
    const pc = createPeer(userId);
    try {
      await pc.setLocalDescription();
      pc._offerAt = Date.now();
      socket.emit('webrtc-signal', { to: userId, data: { type: 'offer', sdp: pc.localDescription.sdp } });
    } catch (err) {
      console.error('[voice] offer failed:', err);
      dropPeer(userId);
    }
  }, [createPeer, dropPeer]);

  const handleSignal = useCallback(async ({ from, data }) => {
    const socket = socketRef.current;
    // Always answer signaling — even while our mic is muted we must accept the
    // remote's audio (recvonly transceiver) so we can hear + lipsync them.
    if (!socket || !data?.type) return;
    try {
      const pc = createPeer(from);
      if (data.type === 'offer') {
        // Offer collision: the peer with the lexicographically smaller id wins;
        // the larger id rolls back its own pending offer and answers.
        // EXCEPTION: a stale pending offer (>4s unanswered — e.g. sent while
        // the remote had voice off and dropped it) always yields to the fresh
        // offer, otherwise both sides deadlock in have-local-offer.
        if (pc.signalingState !== 'stable') {
          const stale = Date.now() - (pc._offerAt || 0) > 4000;
          if (socket.id < from && !stale) return;
          await pc.setLocalDescription({ type: 'rollback' });
        }
        await pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
        await pc.setLocalDescription();
        socket.emit('webrtc-signal', { to: from, data: { type: 'answer', sdp: pc.localDescription.sdp } });
      } else if (data.type === 'answer') {
        if (pc.signalingState === 'have-local-offer') {
          await pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
        }
      } else if (data.type === 'ice' && data.candidate) {
        await pc.addIceCandidate(data.candidate).catch(() => {});
      }
    } catch (err) {
      console.error('[voice] signal handling failed:', err);
    }
  }, [createPeer]);

  // Attach to the room socket once Scene has created it. Existing members call
  // newcomers ('user-joined'); newcomers answer ('webrtc-signal').
  const attachSocket = useCallback((socket) => {
    if (!socket || socketRef.current === socket) return;
    socketRef.current = socket;
    socket.on('webrtc-signal', (msg) => handleSignal(msg));
    socket.on('user-joined', (player) => {
      if (!voiceOnRef.current || !player?.userId) return;
      // A rejoining user (grace-window reconnect or fresh socket) arrives with
      // a brand-new peer context — drop any stale RTCPeerConnection so the
      // offer restarts cleanly instead of hitting the early-return guard.
      if (peersRef.current.has(player.userId)) dropPeer(player.userId);
      callPeer(player.userId);
    });
    socket.on('user-left', ({ userId }) => dropPeer(userId));
  }, [callPeer, dropPeer, handleSignal]);

  const setRemotePlayers = useCallback((players) => {
    remotePlayersRef.current = players || [];
  }, []);

  // Mute-style toggle: the peer mesh and remote audio STAY connected — only
  // the local mic track is enabled/disabled. Each device is independent: one
  // browser muting never tears down anyone else's link.
  const toggleVoice = useCallback(async () => {
    if (voiceOnRef.current) {
      localStreamRef.current?.getAudioTracks().forEach((t) => { t.enabled = false; });
      setVoiceOn(false);
      return;
    }
    if (localStreamRef.current) {
      localStreamRef.current.getAudioTracks().forEach((t) => { t.enabled = true; });
      setVoiceOn(true);
      return;
    }
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Microphone unavailable — voice chat needs HTTPS or localhost.');
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      localStreamRef.current = stream;
      setVoiceOn(true);
      // Attach the mic to existing peers (onnegotiationneeded fires) and call
      // everyone else; newcomers get called via user-joined.
      peersRef.current.forEach((pc) => {
        stream.getTracks().forEach((t) => pc.addTrack(t, stream));
      });
      remotePlayersRef.current.forEach((p) => { if (p?.userId) callPeer(p.userId); });
    } catch (err) {
      console.error('[voice] microphone access failed:', err);
      const reason = err?.name === 'NotAllowedError'
        ? 'Microphone access is blocked. Click the lock/camera icon in the address bar, allow the microphone, then try again.'
        : `Microphone error: ${err?.message || err?.name || err}`;
      alert(reason);
    }
  }, [callPeer]);

  return { voiceOn, toggleVoice, remoteStreams, attachSocket, setRemotePlayers };
}
