// // backend/server.js

// import cors from "cors";
// import dotenv from "dotenv";
// import express from "express";
// import fs from 'fs/promises';
// import path from 'path';
// import { openAIChain, parser } from "./modules/openAI.mjs";
// import { lipSync } from "./modules/lip-sync.mjs";
// import { sendDefaultMessages, defaultResponse } from "./modules/defaultMessages.mjs";
// import { convertAudioToText } from "./modules/whisper.mjs";
// import { voice, initializeElevenLabs } from "./modules/elevenLabs.mjs";  // Update import

// dotenv.config();

// const app = express();
// app.use(express.json());
// app.use(cors());
// const port = 3000;

// // New endpoint to get current settings
// app.get("/settings", async (req, res) => {
//   try {
//     const settings = {
//       openaiModel: process.env.OPENAI_MODEL,
//       openaiApiKey: process.env.OPENAI_API_KEY,
//       elevenLabsApiKey: process.env.ELEVEN_LABS_API_KEY,
//       elevenLabsVoiceId: process.env.ELEVEN_LABS_VOICE_ID,
//       elevenLabsModelId: process.env.ELEVEN_LABS_MODEL_ID
//     };
//     res.status(200).json(settings);
//   } catch (error) {
//     console.error('Error getting settings:', error);
//     res.status(500).json({ error: 'Failed to get settings' });
//   }
// });

// // // New endpoint to update settings
// // app.post("/settings", async (req, res) => {
// //   try {
// //     const {
// //       openaiModel,
// //       openaiApiKey,
// //       elevenLabsApiKey,
// //       elevenLabsVoiceId,
// //       elevenLabsModelId
// //     } = req.body;

// //     // Create new .env content
// //     const envContent = `# OPENAI
// // OPENAI_MODEL=${openaiModel || 'gpt-4'}
// // OPENAI_API_KEY=${openaiApiKey || ''}

// // # Elevenlabs
// // ELEVEN_LABS_API_KEY=${elevenLabsApiKey || ''}
// // ELEVEN_LABS_VOICE_ID=${elevenLabsVoiceId || ''}
// // ELEVEN_LABS_MODEL_ID=${elevenLabsModelId || 'eleven_multilingual_v1'}
// // `;

// //     // Write to .env file
// //     await fs.writeFile('.env', envContent);

// //     // Update process.env variables
// //     process.env.OPENAI_MODEL = openaiModel;
// //     process.env.OPENAI_API_KEY = openaiApiKey;
// //     process.env.ELEVEN_LABS_API_KEY = elevenLabsApiKey;
// //     process.env.ELEVEN_LABS_VOICE_ID = elevenLabsVoiceId;
// //     process.env.ELEVEN_LABS_MODEL_ID = elevenLabsModelId;

// //     res.status(200).json({ message: 'Settings updated successfully' });
// //   } catch (error) {
// //     console.error('Error updating settings:', error);
// //     res.status(500).json({ error: 'Failed to update settings' });
// //   }
// // });

// // New endpoint to update settings
// app.post("/settings", async (req, res) => {
//   try {
//     const newSettings = req.body;

//     // Read current .env file content
//     let currentEnv = {};
//     try {
//       const envContent = await fs.readFile('.env', 'utf-8');
//       envContent.split('\n').forEach(line => {
//         const [key, value] = line.split('=');
//         if (key && value) {
//           currentEnv[key.trim()] = value.trim();
//         }
//       });
//     } catch (error) {
//       console.log('No existing .env file found');
//     }

//     // Update only provided values
//     const envContent = `# OPENAI
// OPENAI_MODEL=${newSettings.openaiModel || currentEnv.OPENAI_MODEL || 'gpt-4'}
// OPENAI_API_KEY=${newSettings.openaiApiKey || currentEnv.OPENAI_API_KEY || ''}

// # Elevenlabs
// ELEVEN_LABS_API_KEY=${newSettings.elevenLabsApiKey || currentEnv.ELEVEN_LABS_API_KEY || ''}
// ELEVEN_LABS_VOICE_ID=${newSettings.elevenLabsVoiceId || currentEnv.ELEVEN_LABS_VOICE_ID || ''}
// ELEVEN_LABS_MODEL_ID=${newSettings.elevenLabsModelId || currentEnv.ELEVEN_LABS_MODEL_ID || 'eleven_multilingual_v1'}
// `;

//     // Write to .env file
//     await fs.writeFile('.env', envContent);

//     // Update process.env variables
//     process.env.OPENAI_MODEL = newSettings.openaiModel || currentEnv.OPENAI_MODEL;
//     process.env.OPENAI_API_KEY = newSettings.openaiApiKey || currentEnv.OPENAI_API_KEY;
//     process.env.ELEVEN_LABS_API_KEY = newSettings.elevenLabsApiKey || currentEnv.ELEVEN_LABS_API_KEY;
//     process.env.ELEVEN_LABS_VOICE_ID = newSettings.elevenLabsVoiceId || currentEnv.ELEVEN_LABS_VOICE_ID;
//     process.env.ELEVEN_LABS_MODEL_ID = newSettings.elevenLabsModelId || currentEnv.ELEVEN_LABS_MODEL_ID;

//     // Reinitialize services
//     await initializeElevenLabs();

//     res.status(200).json({ 
//       message: 'Settings updated successfully',
//       settings: {
//         openaiModel: process.env.OPENAI_MODEL,
//         openaiApiKey: process.env.OPENAI_API_KEY,
//         elevenLabsApiKey: process.env.ELEVEN_LABS_API_KEY,
//         elevenLabsVoiceId: process.env.ELEVEN_LABS_VOICE_ID,
//         elevenLabsModelId: process.env.ELEVEN_LABS_MODEL_ID
//       }
//     });
//   } catch (error) {
//     console.error('Error updating settings:', error);
//     res.status(500).json({ error: 'Failed to update settings' });
//   }
// });

// // Existing TTS endpoint
// app.post("/tts", async (req, res) => {
//   try {
//     const userMessage = req.body.message;
//     const defaultMessages = await sendDefaultMessages({ userMessage });
    
//     if (defaultMessages) {
//       res.send({ messages: defaultMessages });
//       return;
//     }
    
//     const openAIResponse = await openAIChain.invoke({
//       question: userMessage,
//       format_instructions: parser.getFormatInstructions(),
//     });

//     if (!openAIResponse || !openAIResponse.messages || !Array.isArray(openAIResponse.messages)) {
//       throw new Error('Invalid response format from OpenAI');
//     }

//     const processedMessages = await lipSync({ messages: openAIResponse.messages });
//     res.send({ messages: processedMessages });
    
//   } catch (error) {
//     console.error('Error:', error);
//     const errorResponse = [{
//       text: "I'm sorry, there seems to be an error. Could you please try again?",
//       facialExpression: "sad",
//       animation: "Idle"
//     }];
//     try {
//       const processedError = await lipSync({ messages: errorResponse });
//       res.send({ messages: processedError });
//     } catch (e) {
//       res.status(500).send({ error: 'Failed to process response' });
//     }
//   }
// });

// // Existing STS endpoint
// app.post("/sts", async (req, res) => {
//   try {
//     const base64Audio = req.body.audio;
//     const audioData = Buffer.from(base64Audio, "base64");
//     const userMessage = await convertAudioToText({ audioData });
    
//     let openAImessages;
//     try {
//       openAImessages = await openAIChain.invoke({
//         question: userMessage,
//         format_instructions: parser.getFormatInstructions(),
//       });
//     } catch (error) {
//       openAImessages = defaultResponse;
//     }
    
//     const processedMessages = await lipSync({ messages: openAImessages.messages });
//     res.send({ messages: processedMessages });
//   } catch (error) {
//     console.error('Error in STS:', error);
//     res.status(500).json({ error: 'Failed to process speech to text' });
//   }
// });

// app.listen(port, () => {
//   console.log(`Professor Abed is listening on port ${port}`);
// });




import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import fs from 'fs/promises';
import { openAIChain, parser } from "./modules/openAI.mjs";
import { lipSync } from "./modules/lip-sync.mjs";
import { sendDefaultMessages, defaultResponse } from "./modules/defaultMessages.mjs";
import { convertAudioToText } from "./modules/whisper.mjs";
import { voice, initializeElevenLabs } from "./modules/elevenLabs.mjs";

dotenv.config();

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(cors());
const port = 3000;

// Function to handle OpenAI response that might be an array or an object with a messages property
function normalizeOpenAIResponse(response) {
  if (Array.isArray(response)) {
    return { messages: response };
  } else if (response && response.messages && Array.isArray(response.messages)) {
    return response;
  } else if (response && typeof response === 'object') {
    // Last resort: try to extract any array-like property
    for (const key in response) {
      if (Array.isArray(response[key])) {
        return { messages: response[key] };
      }
    }
  }
  
  // If all else fails, return default response
  return { messages: defaultResponse };
}

// New endpoint to get current settings
app.get("/settings", async (req, res) => {
  try {
    const settings = {
      openaiModel: process.env.OPENAI_MODEL,
      openaiApiKey: process.env.OPENAI_API_KEY,
      elevenLabsApiKey: process.env.ELEVEN_LABS_API_KEY,
      elevenLabsVoiceId: process.env.ELEVEN_LABS_VOICE_ID,
      elevenLabsModelId: process.env.ELEVEN_LABS_MODEL_ID
    };
    res.status(200).json(settings);
  } catch (error) {
    console.error('Error getting settings:', error);
    res.status(500).json({ error: 'Failed to get settings' });
  }
});

// New endpoint to update settings
app.post("/settings", async (req, res) => {
  try {
    const newSettings = req.body;

    // Read current .env file content
    let currentEnv = {};
    try {
      const envContent = await fs.readFile('.env', 'utf-8');
      envContent.split('\n').forEach(line => {
        const [key, value] = line.split('=');
        if (key && value) {
          currentEnv[key.trim()] = value.trim();
        }
      });
    } catch (error) {
      console.log('No existing .env file found');
    }

    // Update only provided values
    const envContent = `# OPENAI
OPENAI_MODEL=${newSettings.openaiModel || currentEnv.OPENAI_MODEL || 'gpt-4'}
OPENAI_API_KEY=${newSettings.openaiApiKey || currentEnv.OPENAI_API_KEY || ''}

# Elevenlabs
ELEVEN_LABS_API_KEY=${newSettings.elevenLabsApiKey || currentEnv.ELEVEN_LABS_API_KEY || ''}
ELEVEN_LABS_VOICE_ID=${newSettings.elevenLabsVoiceId || currentEnv.ELEVEN_LABS_VOICE_ID || ''}
ELEVEN_LABS_MODEL_ID=${newSettings.elevenLabsModelId || currentEnv.ELEVEN_LABS_MODEL_ID || 'eleven_multilingual_v1'}
`;

    // Write to .env file
    await fs.writeFile('.env', envContent);

    // Update process.env variables
    process.env.OPENAI_MODEL = newSettings.openaiModel || currentEnv.OPENAI_MODEL;
    process.env.OPENAI_API_KEY = newSettings.openaiApiKey || currentEnv.OPENAI_API_KEY;
    process.env.ELEVEN_LABS_API_KEY = newSettings.elevenLabsApiKey || currentEnv.ELEVEN_LABS_API_KEY;
    process.env.ELEVEN_LABS_VOICE_ID = newSettings.elevenLabsVoiceId || currentEnv.ELEVEN_LABS_VOICE_ID;
    process.env.ELEVEN_LABS_MODEL_ID = newSettings.elevenLabsModelId || currentEnv.ELEVEN_LABS_MODEL_ID;

    // Reinitialize services
    await initializeElevenLabs();

    res.status(200).json({ 
      message: 'Settings updated successfully',
      settings: {
        openaiModel: process.env.OPENAI_MODEL,
        openaiApiKey: process.env.OPENAI_API_KEY,
        elevenLabsApiKey: process.env.ELEVEN_LABS_API_KEY,
        elevenLabsVoiceId: process.env.ELEVEN_LABS_VOICE_ID,
        elevenLabsModelId: process.env.ELEVEN_LABS_MODEL_ID
      }
    });
  } catch (error) {
    console.error('Error updating settings:', error);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// Existing TTS endpoint with improved error handling
app.post("/tts", async (req, res) => {
  try {
    const userMessage = req.body.message;
    const defaultMessages = await sendDefaultMessages({ userMessage });
    
    if (defaultMessages) {
      res.send({ messages: defaultMessages });
      return;
    }
    
    let openAIResponse;
    try {
      openAIResponse = await openAIChain.invoke({
        question: userMessage,
        format_instructions: parser.getFormatInstructions(),
      });
      
      // Normalize the response format
      openAIResponse = normalizeOpenAIResponse(openAIResponse);
      
    } catch (error) {
      console.error('OpenAI Error:', error);
      
      // If there's an error with the parser but we have raw LLM output
      if (error.llmOutput) {
        try {
          // Try to parse the raw output
          const rawOutput = JSON.parse(error.llmOutput);
          if (Array.isArray(rawOutput)) {
            openAIResponse = { messages: rawOutput };
          } else {
            throw new Error('Invalid format after parsing raw output');
          }
        } catch (parseError) {
          console.error('Error parsing raw output:', parseError);
          openAIResponse = { messages: defaultResponse };
        }
      } else {
        openAIResponse = { messages: defaultResponse };
      }
    }

    const processedMessages = await lipSync({ messages: openAIResponse.messages });
    res.send({ messages: processedMessages });
    
  } catch (error) {
    console.error('Error:', error);
    const errorResponse = [{
      text: "I'm sorry, there seems to be an error. Could you please try again?",
      facialExpression: "sad",
      animation: "Idle"
    }];
    try {
      const processedError = await lipSync({ messages: errorResponse });
      res.send({ messages: processedError });
    } catch (e) {
      res.status(500).send({ error: 'Failed to process response' });
    }
  }
});

// Existing STS endpoint with improved error handling
app.post("/sts", async (req, res) => {
  try {
    const base64Audio = req.body.audio;
    const audioData = Buffer.from(base64Audio, "base64");
    const userMessage = await convertAudioToText({ audioData });
    
    let openAIResponse;
    try {
      openAIResponse = await openAIChain.invoke({
        question: userMessage,
        format_instructions: parser.getFormatInstructions(),
      });
      
      // Normalize the response format
      openAIResponse = normalizeOpenAIResponse(openAIResponse);
      
    } catch (error) {
      console.error('OpenAI Error in STS:', error);
      
      // If there's an error with the parser but we have raw LLM output
      if (error.llmOutput) {
        try {
          // Try to parse the raw output
          const rawOutput = JSON.parse(error.llmOutput);
          if (Array.isArray(rawOutput)) {
            openAIResponse = { messages: rawOutput };
          } else {
            throw new Error('Invalid format after parsing raw output');
          }
        } catch (parseError) {
          console.error('Error parsing raw output in STS:', parseError);
          openAIResponse = { messages: defaultResponse };
        }
      } else {
        openAIResponse = { messages: defaultResponse };
      }
    }

    const processedMessages = await lipSync({ messages: openAIResponse.messages });
    res.send({ messages: processedMessages });
  } catch (error) {
    console.error('Error in STS:', error);
    res.status(500).json({ error: 'Failed to process speech to text' });
  }
});

// Voice endpoint
app.get("/voices", async (req, res) => {
  try {
    res.send(await voice.getVoices(process.env.ELEVEN_LABS_API_KEY));
  } catch (error) {
    console.error('Error getting voices:', error);
    res.status(500).json({ error: 'Failed to get voices' });
  }
});

app.listen(port, () => {
  console.log(`Professor Abed is listening on port ${port}`);
});