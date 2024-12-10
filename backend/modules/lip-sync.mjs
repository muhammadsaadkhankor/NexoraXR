import { convertTextToSpeech } from "./elevenLabs.mjs";
import { getPhonemes } from "./rhubarbLipSync.mjs";
import { readJsonTranscript, audioFileToBase64 } from "../utils/files.mjs";
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';

const execAsync = promisify(exec);
const MAX_RETRIES = 10;
const RETRY_DELAY = 100;

// Check if required dependencies are installed
const checkDependencies = async () => {
  try {
    await execAsync('ffmpeg -version');
    await execAsync('ffprobe -version');
    return true;
  } catch (error) {
    console.error('Required dependencies are missing. Please install ffmpeg:');
    console.error('sudo apt update && sudo apt install ffmpeg');
    return false;
  }
};

// Ensure directory exists
const ensureDirectory = async (dirPath) => {
  try {
    await fs.access(dirPath);
  } catch {
    await fs.mkdir(dirPath, { recursive: true });
  }
};

// Get audio duration using ffprobe with better error handling
const getAudioDuration = async (fileName) => {
  try {
    // Verify file exists
    await fs.access(fileName);
    
    const { stdout, stderr } = await execAsync(
      `ffprobe -i "${fileName}" -show_entries format=duration -v quiet -of csv="p=0"`
    );
    
    if (stderr) {
      console.warn('FFprobe warning:', stderr);
    }
    
    const duration = parseFloat(stdout.trim());
    if (isNaN(duration)) {
      throw new Error('Invalid duration value received from ffprobe');
    }
    
    return duration;
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`Audio file not found: ${fileName}`);
    }
    console.error('Error getting audio duration:', error);
    throw new Error('Failed to get audio duration: ' + error.message);
  }
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const lipSync = async ({ messages }) => {
  if (!Array.isArray(messages)) {
    throw new TypeError("Expected messages to be an array");
  }

  // Check dependencies first
  const dependenciesInstalled = await checkDependencies();
  if (!dependenciesInstalled) {
    throw new Error('Required dependencies are not installed. Please install ffmpeg.');
  }

  // Ensure audios directory exists
  await ensureDirectory('audios');

  // First pass: Convert all texts to speech
  await Promise.all(
    messages.map(async (message, index) => {
      const fileName = path.join('audios', `message_${index}.mp3`);

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
    })
  );

  // Second pass: Generate lip sync data
  await Promise.all(
    messages.map(async (message, index) => {
      const fileName = path.join('audios', `message_${index}.mp3`);

      try {
        // Get phonemes first
        await getPhonemes({ message: index });
        
        // Get audio file as base64
        message.audio = await audioFileToBase64({ fileName });
        
        // Read lip sync data
        const lipSyncFile = path.join('audios', `message_${index}.json`);
        message.lipsync = await readJsonTranscript({ fileName: lipSyncFile });

        // Get actual audio duration
        const audioDuration = await getAudioDuration(fileName);

        // Validate and adjust lip sync timing
        if (message.lipsync && Array.isArray(message.lipsync)) {
          const lastEntry = message.lipsync[message.lipsync.length - 1];
          if (lastEntry && lastEntry.end < audioDuration) {
            message.lipsync.push({
              start: lastEntry.end,
              end: audioDuration,
              value: "X"
            });
          }
        }

        console.log({
          messageIndex: index,
          audioFile: fileName,
          audioDuration,
          lipSyncEntries: message.lipsync.length,
          firstEntry: message.lipsync[0],
          lastEntry: message.lipsync[message.lipsync.length - 1]
        });

      } catch (error) {
        console.error(`Error processing message ${index}:`, error);
        throw error;
      }
    })
  );

  return messages;
};

export { lipSync };