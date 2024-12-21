import React, { useRef, useEffect, useState } from 'react';
import { useGLTF, useAnimations } from '@react-three/drei';
import { useFrame } from "@react-three/fiber";
import { button, useControls } from "leva";
import * as THREE from "three";
import { useSpeech } from "../hooks/useSpeech";
import facialExpressions from "../constants/facialExpressions";
import visemesMapping from "../constants/visemesMapping";
import morphTargets from "../constants/morphTargets";

const DEFAULT_AVATAR_PATH = '/models/ProfAbed_suit.glb';
const ANIMATIONS_PATH = '/models/animations.glb';

export function Avatar({ modelPath = DEFAULT_AVATAR_PATH, ...props }) {
  const group = useRef();
  const previousModelPath = useRef(modelPath);

  useEffect(() => {
    console.log('Model path changed:', modelPath);
    if (previousModelPath.current !== modelPath) {
      console.log('Loading new model...');
      useGLTF.preload(modelPath);
      useGLTF.dispose(previousModelPath.current);
      previousModelPath.current = modelPath;
    }
  }, [modelPath]);

  const { nodes, materials } = useGLTF(modelPath);
  const { animations } = useGLTF(ANIMATIONS_PATH);
  const { actions, mixer } = useAnimations(animations, group);
  const { message, onMessagePlayed } = useSpeech();

  const [lipsync, setLipsync] = useState();
  const [setupMode, setSetupMode] = useState(false);
  const [animation, setAnimation] = useState(animations.find((a) => a.name === "Idle") ? "Idle" : animations[0].name);
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
      return;
    }
    setAnimation(message.animation);
    setFacialExpression(message.facialExpression);
    setLipsync(message.lipsync);
    const audio = new Audio("data:audio/mp3;base64," + message.audio);
    audio.play();
    setAudio(audio);
    audio.onended = onMessagePlayed;
  }, [message]);

  useEffect(() => {
    if (actions[animation]) {
      actions[animation]
        .reset()
        .fadeIn(mixer.stats.actions.inUse === 0 ? 0 : 0.5)
        .play();
      return () => {
        if (actions[animation]) {
          actions[animation].fadeOut(0.5);
        }
      };
    }
  }, [animation]);

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
    if (!setupMode) {
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
      if (message && lipsync) {
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
    }
  });

  useControls("FacialExpressions", {
    animation: {
      value: animation,
      options: animations.map((a) => a.name),
      onChange: (value) => setAnimation(value),
    },
    facialExpression: {
      options: Object.keys(facialExpressions),
      onChange: (value) => setFacialExpression(value),
    },
    setupMode: button(() => {
      setSetupMode(!setupMode);
    }),
    logMorphTargetValues: button(() => {
      const emotionValues = {};
      Object.values(nodes).forEach((node) => {
        if (node.morphTargetInfluences && node.morphTargetDictionary) {
          morphTargets.forEach((key) => {
            if (key === "eyeBlinkLeft" || key === "eyeBlinkRight") {
              return;
            }
            const value = node.morphTargetInfluences[node.morphTargetDictionary[key]];
            if (value > 0.01) {
              emotionValues[key] = value;
            }
          });
        }
      });
      console.log(JSON.stringify(emotionValues, null, 2));
    }),
  });

  const renderMeshes = (nodes, materials) => {
    return Object.values(nodes).map((node) => {
      if (node.isMesh || node.isSkinnedMesh) {
        return (
          <skinnedMesh
            key={node.uuid}
            geometry={node.geometry}
            material={materials[node.material.name]}
            skeleton={node.skeleton}
            morphTargetDictionary={node.morphTargetDictionary}
            morphTargetInfluences={node.morphTargetInfluences}
          />
        );
      }
      return null;
    });
  };

  return (
    <group ref={group} {...props} dispose={null}>
      {nodes && nodes.Hips && <primitive object={nodes.Hips} />}
      {nodes && materials && renderMeshes(nodes, materials)}
    </group>
  );
}

useGLTF.preload(DEFAULT_AVATAR_PATH);