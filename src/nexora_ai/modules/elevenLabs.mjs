// import ElevenLabs from "elevenlabs-node";
// import dotenv from "dotenv";
// dotenv.config();

// const elevenLabsApiKey = process.env.ELEVEN_LABS_API_KEY;
// const voiceID = process.env.ELEVEN_LABS_VOICE_ID;
// const modelID = process.env.ELEVEN_LABS_MODEL_ID;

// const voice = new ElevenLabs({
//   apiKey: elevenLabsApiKey,
//   voiceId: voiceID,
// });

// async function convertTextToSpeech({ text, fileName }) {
//   await voice.textToSpeech({
//     fileName: fileName,
//     textInput: text,
//     voiceId: voiceID,
//     stability: 0.5,
//     similarityBoost: 0.5,
//     modelId: modelID,
//     style: 1,
//     speakerBoost: true,
//   });
// }

// export { convertTextToSpeech, voice };



// backend/modules/elevenLabs.mjs

import ElevenLabs from "elevenlabs-node";
import dotenv from "dotenv";

dotenv.config();

let voice;

export const initializeElevenLabs = () => {
  voice = new ElevenLabs({
    apiKey: process.env.ELEVEN_LABS_API_KEY,
    voiceId: process.env.ELEVEN_LABS_VOICE_ID,
  });
};

// Initialize on module load
initializeElevenLabs();

export async function convertTextToSpeech({ text, fileName }) {
  await voice.textToSpeech({
    fileName: fileName,
    textInput: text,
    voiceId: process.env.ELEVEN_LABS_VOICE_ID, // Use current voiceId from env
    stability: 0.5,
    similarityBoost: 0.5,
    modelId: process.env.ELEVEN_LABS_MODEL_ID,
    style: 1,
    speakerBoost: true,
  });
}

export { voice };