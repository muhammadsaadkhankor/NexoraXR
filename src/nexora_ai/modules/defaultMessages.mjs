import { audioFileToBase64, readJsonTranscript } from "../utils/files.mjs";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUDIOS_DIR = path.join(__dirname, "..", "audios");

const openAIApiKey = process.env.OPENAI_API_KEY;
const elevenLabsApiKey = process.env.ELEVEN_LABS_API_KEY;

async function sendDefaultMessages({ userMessage }) {
  let messages;
  if (!userMessage) {
    messages = [
      {
        text: "Hey there... How was your day?",
        audio: await audioFileToBase64({ fileName: path.join(AUDIOS_DIR, "intro_0.wav") }),
        lipsync: await readJsonTranscript({ fileName: path.join(AUDIOS_DIR, "intro_0.json") }),
        facialExpression: "smile",
        animation: "TalkingOne",
      },
      {
        text: "I'm Professor Abed, your personal AI assistant. I'm here to help you with anything you need.",
        audio: await audioFileToBase64({ fileName: path.join(AUDIOS_DIR, "intro_1.wav") }),
        lipsync: await readJsonTranscript({ fileName: path.join(AUDIOS_DIR, "intro_1.json") }),
        facialExpression: "smile",
        animation: "TalkingTwo",
      },
    ];
    return messages;
  }
  if (!elevenLabsApiKey || !openAIApiKey) {
    messages = [
      {
        text: "Please my friend, don't forget to add your API keys!",
        audio: await audioFileToBase64({ fileName: path.join(AUDIOS_DIR, "api_0.wav") }),
        lipsync: await readJsonTranscript({ fileName: path.join(AUDIOS_DIR, "api_0.json") }),
        facialExpression: "angry",
        animation: "TalkingThree",
      },
      {
        text: "You don't want to ruin Jack with a crazy ChatGPT and ElevenLabs bill, right?",
        audio: await audioFileToBase64({ fileName: path.join(AUDIOS_DIR, "api_1.wav") }),
        lipsync: await readJsonTranscript({ fileName: path.join(AUDIOS_DIR, "api_1.json") }),
        facialExpression: "smile",
        animation: "Angry",
      },
    ];
    return messages;
  }
}

const defaultResponse = [
  {
    text: "I'm sorry, there seems to be an error with my brain, or I didn't understand. Could you please repeat your question?",
    facialExpression: "sad",
    animation: "Idle",
  },
];

export { sendDefaultMessages, defaultResponse };
