import { execCommand } from "../utils/files.mjs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUDIOS_DIR = path.join(__dirname, "..", "audios");
const RHUBARB_BIN = path.join(__dirname, "..", "bin", "rhubarb");

const getPhonemes = async ({ message }) => {
  try {
    const time = new Date().getTime();
    console.log(`Starting conversion for message ${message}`);
    await execCommand(
      { command: `ffmpeg -y -i ${path.join(AUDIOS_DIR, `message_${message}.mp3`)} ${path.join(AUDIOS_DIR, `message_${message}.wav`)}` }
      // -y to overwrite the file
    );
    console.log(`Conversion done in ${new Date().getTime() - time}ms`);
    await execCommand({
      command: `${RHUBARB_BIN} -f json -o ${path.join(AUDIOS_DIR, `message_${message}.json`)} ${path.join(AUDIOS_DIR, `message_${message}.wav`)} -r phonetic`,
    });
    // -r phonetic is faster but less accurate
    console.log(`Lip sync done in ${new Date().getTime() - time}ms`);
  } catch (error) {
    console.error(`Error while getting phonemes for message ${message}:`, error);
  }
};

export { getPhonemes };
