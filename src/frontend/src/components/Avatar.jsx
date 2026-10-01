import React, { useRef, useLayoutEffect, useEffect, useState, useMemo } from 'react';
import { useGLTF, useAnimations } from '@react-three/drei';
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useSpeech } from "../hooks/useSpeech";
import facialExpressions from "../constants/facialExpressions";
import visemesMapping from "../constants/visemesMapping";
import morphTargets from "../constants/morphTargets";

const DEFAULT_AVATAR_PATH = '/assets/avatar/ProfAbed_suit.glb';
const EXTRA_ANIMATIONS_URL = '/models/animations.glb';

const ANIMATION_MAP = {
  explain: 'TalkingOne',
  explain2: 'TalkingTwo',
  explain3: 'TalkingThree',
  idle: 'Idle',
  Idle: 'Idle',
  happy: 'HappyIdle',
  sad: 'SadIdle',
  angry: 'Angry',
  surprised: 'Surprised',
  think: 'ThoughtfulHeadShake',
  dismiss: 'DismissingGesture',
};

function resolveAnimation(name, actions) {
  const mapped = ANIMATION_MAP[name] ?? name;
  if (actions && actions[mapped]) return mapped;
  if (actions && actions['Idle']) return 'Idle';
  return null;
}

export function Avatar({ modelPath = DEFAULT_AVATAR_PATH, ...props }) {
  const group = useRef();
  const previousModelPath = useRef(modelPath);

  useEffect(() => {
    if (previousModelPath.current !== modelPath) {
      useGLTF.preload(modelPath);
      useGLTF.dispose(previousModelPath.current);
      previousModelPath.current = modelPath;
    }
  }, [modelPath]);

  const { scene, nodes, animations: avatarAnimations } = useGLTF(modelPath);
  const { animations: extraAnimations } = useGLTF(EXTRA_ANIMATIONS_URL);

  const animations = useMemo(() => {
    const clips = [];
    if (avatarAnimations) clips.push(...avatarAnimations.map((clip) => clip.clone()));
    if (extraAnimations) clips.push(...extraAnimations.map((clip) => clip.clone()));
    const nodeNames = new Set(Object.keys(nodes || {}));
    clips.forEach((clip) => {
      clip.tracks = clip.tracks.filter((track) => {
        const dot = track.name.lastIndexOf('.');
        const nodeName = dot > 0 ? track.name.substring(0, dot) : track.name;
        return nodeNames.has(nodeName);
      });
    });
    return clips;
  }, [avatarAnimations, extraAnimations, nodes]);

  const { actions, mixer } = useAnimations(animations, group);
  const { message, onMessagePlayed, audioElementRef, floorPausedRef, floorPaused } = useSpeech();

  const [lipsync, setLipsync] = useState();
  const [animation, setAnimation] = useState("Idle");
  const [blink, setBlink] = useState(false);
  const [facialExpression, setFacialExpression] = useState("");
  const [audio, setAudio] = useState();

  const lerpMorphTarget = (target, value, speed = 0.1) => {
    group.current.traverse((child) => {
      if (child.isSkinnedMesh && child.morphTargetDictionary) {
        const index = child.morphTargetDictionary[target];
        if (index === undefined || child.morphTargetInfluences[index] === undefined) {
          return;
        }
        child.morphTargetInfluences[index] = THREE.MathUtils.lerp(child.morphTargetInfluences[index], value, speed);
      }
    });
  };

  useEffect(() => {
    if (!message) {
      setAnimation("Idle");
      setFacialExpression("");
      setLipsync(undefined);
      if (audio) {
        audio.pause();
        audio.currentTime = 0;
      }
      setAudio(undefined);
      if (audioElementRef) audioElementRef.current = null;
      return;
    }
    const resolved = resolveAnimation(message.animation, actions);
    setAnimation(resolved || "Idle");
    setFacialExpression(message.facialExpression);
    setLipsync(message.lipsync);
    const nextAudio = message.audio
      ? new Audio("data:audio/mp3;base64," + message.audio)
      : message.audioUrl
      ? new Audio(message.audioUrl)
      : null;
    if (nextAudio) {
      const savedResumeAt =
        typeof message.resumeAt === 'number' && message.resumeAt > 0 ? message.resumeAt : null;
      if (savedResumeAt !== null) {
        // Seeking before metadata loads is unreliable on a fresh element —
        // wait for loadedmetadata, then apply the saved position.
        const applySeek = () => {
          try {
            nextAudio.currentTime = savedResumeAt;
            console.log('[LECTURE_RESTORE]', `messageId=${message.id}`, `resumeAt=${savedResumeAt.toFixed(2)}`);
          } catch (e) {
            console.error('[Avatar] failed to apply resumeAt:', e);
          }
        };
        if (nextAudio.readyState >= 1) applySeek();
        else nextAudio.addEventListener('loadedmetadata', applySeek, { once: true });
        // resumeAt survives until this element is actually playing, so a
        // re-created element can still re-apply the saved position.
        nextAudio.addEventListener('playing', () => {
          if (typeof message.resumeAt === 'number') delete message.resumeAt;
        }, { once: true });
      }
      nextAudio.onended = onMessagePlayed;
      nextAudio.onerror = () => {
        console.error('[Avatar] audio error:', nextAudio.src);
        onMessagePlayed?.();
      };
      // A lecture segment resumed while the floor is held stays paused until
      // the shared resume (release-floor) arrives.
      if (message.type === 'lecture' && floorPausedRef?.current) {
        nextAudio.pause();
      } else {
        nextAudio.play().catch((err) => console.error('[Avatar] audio play error:', err));
      }
    } else {
      onMessagePlayed?.();
    }
    setAudio(nextAudio);
    if (audioElementRef) audioElementRef.current = nextAudio;
    return () => {
      if (nextAudio) {
        nextAudio.onended = null;
        nextAudio.onerror = null;
        nextAudio.pause();
        nextAudio.currentTime = 0;
      }
    };
  }, [message]);

  // While the floor is held, a paused lecture message must not keep playing
  // its talking animation or a frozen lipsync cue — fade out every running
  // action except Idle, drop to Idle, and close the mouth. Answer/other
  // messages are unaffected and animate normally. Kept separate from the
  // audio-creation effect above so toggling floorPaused never recreates the
  // audio element or consumes resumeAt.
  useEffect(() => {
    if (floorPaused && message?.type === 'lecture') {
      const idleName = actions && actions['Idle'] ? 'Idle' : (resolveAnimation('idle', actions) || 'Idle');
      Object.entries(actions || {}).forEach(([name, action]) => {
        if (action && name !== idleName && action.isRunning && action.isRunning()) {
          action.fadeOut(0.4);
        }
      });
      setAnimation(idleName);
      setLipsync(undefined);
      console.log('[ANIMATION]', 'lecture →', idleName);
    } else if (message) {
      setAnimation(resolveAnimation(message.animation, actions) || 'Idle');
      setLipsync(message.lipsync);
    }
  }, [floorPaused, message, actions]);

  // While a floor-paused lecture message is at the queue head the professor is
  // listening, not lecturing — force Idle regardless of message.animation.
  const pausedLecture = !!(floorPaused && message?.type === 'lecture');
  const activeAnimation = pausedLecture ? 'Idle' : animation;

  useEffect(() => {
    const target = resolveAnimation(activeAnimation, actions);
    if (!target) return;
    const action = actions[target];
    if (action) {
      action
        .reset()
        .fadeIn(mixer.stats.actions.inUse === 0 ? 0 : 0.5)
        .play();
      return () => {
        if (actions[target]) {
          actions[target].fadeOut(0.5);
        }
      };
    }
  }, [activeAnimation, actions, mixer]);

  useLayoutEffect(() => {
    if (group.current) {
      const { position, rotation, scale } = props;
      if (position) group.current.position.set(position[0], position[1], position[2]);
      if (rotation) group.current.rotation.set(rotation[0], rotation[1], rotation[2]);
      if (scale) group.current.scale.set(scale[0], scale[1], scale[2]);
    }
    const target = resolveAnimation(activeAnimation, actions);
    if (target && actions[target]) {
      actions[target].reset().play().setEffectiveWeight(1);
    }
  }, [group, actions, activeAnimation, props.position, props.rotation, props.scale]);

  useEffect(() => {
    let blinkTimeout;
    const nextBlink = () => {
      blinkTimeout = setTimeout(() => {
        setBlink(true);
        setTimeout(() => {
          setBlink(false);
          nextBlink();
        }, 200);
      }, THREE.MathUtils.randInt(1000, 5000));
    };
    nextBlink();
    return () => clearTimeout(blinkTimeout);
  }, []);

  useFrame(() => {
    const target = resolveAnimation(activeAnimation, actions);
    if (target && actions[target]) actions[target].play().setEffectiveWeight(1);
    morphTargets.forEach((key) => {
        const mapping = facialExpressions[facialExpression];
        if (key === "eyeBlinkLeft" || key === "eyeBlinkRight") {
          return;
        }
        if (mapping && mapping[key]) {
          lerpMorphTarget(key, mapping[key], 0.1);
        } else {
          lerpMorphTarget(key, 0, 0.1);
        }
      });

      lerpMorphTarget("eyeBlinkLeft", blink ? 1 : 0, 0.5);
      lerpMorphTarget("eyeBlinkRight", blink ? 1 : 0, 0.5);

      const appliedMorphTargets = [];
      if (message && lipsync && !pausedLecture) {
        const currentAudioTime = audio.currentTime;
        for (let i = 0; i < lipsync.mouthCues.length; i++) {
          const mouthCue = lipsync.mouthCues[i];
          if (currentAudioTime >= mouthCue.start && currentAudioTime <= mouthCue.end) {
            appliedMorphTargets.push(visemesMapping[mouthCue.value]);
            lerpMorphTarget(visemesMapping[mouthCue.value], 1, 0.2);
            break;
          }
        }
      }

      Object.values(visemesMapping).forEach((value) => {
        if (appliedMorphTargets.includes(value)) {
          return;
        }
        lerpMorphTarget(value, 0, 0.1);
      });
  });

  return (
    <group ref={group} {...props} dispose={null}>
      {scene && <primitive object={scene} />}
    </group>
  );
}

useGLTF.preload(DEFAULT_AVATAR_PATH);
useGLTF.preload(EXTRA_ANIMATIONS_URL);
