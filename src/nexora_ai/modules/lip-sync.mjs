import { convertTextToSpeech } from "./elevenLabs.mjs";
import { audioFileToBase64 } from "../utils/files.mjs";
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUDIOS_DIR = path.join(__dirname, '..', 'audios');

const MAX_RETRIES = 10;
const RETRY_DELAY = 100;

// Ensure directory exists
const ensureDirectory = async (dirPath) => {
  try {
    await fs.access(dirPath);
  } catch {
    await fs.mkdir(dirPath, { recursive: true });
  }
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Generates TTS audio for each message and attaches it as base64. Lip sync is
// handled client-side in real time from the audio signal itself — no server
// mouthCue generation (Rhubarb) is involved.
const lipSync = async ({ messages }) => {
  if (!Array.isArray(messages)) {
    throw new TypeError("Expected messages to be an array");
  }

  await ensureDirectory(AUDIOS_DIR);

  await Promise.all(
    messages.map(async (message, index) => {
      const fileName = path.join(AUDIOS_DIR, `message_${index}.mp3`);

      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          await convertTextToSpeech({ text: message.text, fileName });
          await delay(RETRY_DELAY);
          break;
        } catch (error) {
          console.error(`Attempt ${attempt + 1} failed:`, error.message);
          if (error.response?.status === 429 && attempt < MAX_RETRIES - 1) {
            await delay(Math.pow(2, attempt) * RETRY_DELAY);
          } else {
            throw error;
          }
        }
      }
      console.log(`Message ${index} converted to speech`);

      message.audio = await audioFileToBase64({ fileName });
      message.lipsync = null;
    })
  );

  return messages;
};

export { lipSync };
