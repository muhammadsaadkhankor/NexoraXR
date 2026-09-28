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




// import cors from "cors";
// import dotenv from "dotenv";
// import express from "express";
// import fs from 'fs/promises';
// import { openAIChain, parser } from "./modules/openAI.mjs";
// import { lipSync } from "./modules/lip-sync.mjs";
// import { sendDefaultMessages, defaultResponse } from "./modules/defaultMessages.mjs";
// import { convertAudioToText } from "./modules/whisper.mjs";
// import { voice, initializeElevenLabs } from "./modules/elevenLabs.mjs";

// dotenv.config();

// const app = express();
// app.use(express.json({ limit: '50mb' }));
// app.use(cors());
// const port = 3000;

// // Function to handle OpenAI response that might be an array or an object with a messages property
// function normalizeOpenAIResponse(response) {
//   if (Array.isArray(response)) {
//     return { messages: response };
//   } else if (response && response.messages && Array.isArray(response.messages)) {
//     return response;
//   } else if (response && typeof response === 'object') {
//     // Last resort: try to extract any array-like property
//     for (const key in response) {
//       if (Array.isArray(response[key])) {
//         return { messages: response[key] };
//       }
//     }
//   }
  
//   // If all else fails, return default response
//   return { messages: defaultResponse };
// }

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

// // Existing TTS endpoint with improved error handling
// app.post("/tts", async (req, res) => {
//   try {
//     const userMessage = req.body.message;
//     const defaultMessages = await sendDefaultMessages({ userMessage });
    
//     if (defaultMessages) {
//       res.send({ messages: defaultMessages });
//       return;
//     }
    
//     let openAIResponse;
//     try {
//       openAIResponse = await openAIChain.invoke({
//         question: userMessage,
//         format_instructions: parser.getFormatInstructions(),
//       });
      
//       // Normalize the response format
//       openAIResponse = normalizeOpenAIResponse(openAIResponse);
      
//     } catch (error) {
//       console.error('OpenAI Error:', error);
      
//       // If there's an error with the parser but we have raw LLM output
//       if (error.llmOutput) {
//         try {
//           // Try to parse the raw output
//           const rawOutput = JSON.parse(error.llmOutput);
//           if (Array.isArray(rawOutput)) {
//             openAIResponse = { messages: rawOutput };
//           } else {
//             throw new Error('Invalid format after parsing raw output');
//           }
//         } catch (parseError) {
//           console.error('Error parsing raw output:', parseError);
//           openAIResponse = { messages: defaultResponse };
//         }
//       } else {
//         openAIResponse = { messages: defaultResponse };
//       }
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

// // Existing STS endpoint with improved error handling
// app.post("/sts", async (req, res) => {
//   try {
//     const base64Audio = req.body.audio;
//     const audioData = Buffer.from(base64Audio, "base64");
//     const userMessage = await convertAudioToText({ audioData });
    
//     let openAIResponse;
//     try {
//       openAIResponse = await openAIChain.invoke({
//         question: userMessage,
//         format_instructions: parser.getFormatInstructions(),
//       });
      
//       // Normalize the response format
//       openAIResponse = normalizeOpenAIResponse(openAIResponse);
      
//     } catch (error) {
//       console.error('OpenAI Error in STS:', error);
      
//       // If there's an error with the parser but we have raw LLM output
//       if (error.llmOutput) {
//         try {
//           // Try to parse the raw output
//           const rawOutput = JSON.parse(error.llmOutput);
//           if (Array.isArray(rawOutput)) {
//             openAIResponse = { messages: rawOutput };
//           } else {
//             throw new Error('Invalid format after parsing raw output');
//           }
//         } catch (parseError) {
//           console.error('Error parsing raw output in STS:', parseError);
//           openAIResponse = { messages: defaultResponse };
//         }
//       } else {
//         openAIResponse = { messages: defaultResponse };
//       }
//     }

//     const processedMessages = await lipSync({ messages: openAIResponse.messages });
//     res.send({ messages: processedMessages });
//   } catch (error) {
//     console.error('Error in STS:', error);
//     res.status(500).json({ error: 'Failed to process speech to text' });
//   }
// });

// // Voice endpoint
// app.get("/voices", async (req, res) => {
//   try {
//     res.send(await voice.getVoices(process.env.ELEVEN_LABS_API_KEY));
//   } catch (error) {
//     console.error('Error getting voices:', error);
//     res.status(500).json({ error: 'Failed to get voices' });
//   }
// });

// app.listen(port, () => {
//   console.log(`Professor Abed is listening on port ${port}`);
// });





import 'dotenv/config';
import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import fs from 'fs/promises';
import { openAIChain, parser } from "./modules/openAI.mjs";
import { lipSync } from "./modules/lip-sync.mjs";
import { sendDefaultMessages, defaultResponse } from "./modules/defaultMessages.mjs";
// import { convertAudioToText } from "./modules/whisper.mjs";
import { voice, initializeElevenLabs } from "./modules/elevenLabs.mjs";
import { createServer } from "http";
import { Server } from "socket.io";
import lectureRouter from "./lectureRoutes.mjs";

dotenv.config();

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(cors());
const port = process.env.PORT || 3000;

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

// NEW: Transcribe endpoint - only transcribes audio to text
// Add this new endpoint if it doesn't exist, or update it
// app.post("/transcribe", async (req, res) => {
//   try {
//     const base64Audio = req.body.audio;
//     const language = req.body.language || "en"; // Default to English if not specified
    
//     const audioData = Buffer.from(base64Audio, "base64");
//     const userMessage = await convertAudioToText({ audioData, language });
    
//     res.json({ text: userMessage });
//   } catch (error) {
//     console.error('Error in transcription:', error);
//     res.status(500).json({ error: 'Failed to transcribe audio' });
//   }
// });

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

app.use('/api', lectureRouter);

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const rooms = {};
const socketRoom = new Map();
const socialStates = {};

function getSocialState(roomId) {
  if (!socialStates[roomId]) {
    socialStates[roomId] = {
      floorQueue: [],
      activeSpeaker: null,
      lecturePaused: false,
      lecturePausedBy: null,
      answering: false
    };
  }
  return socialStates[roomId];
}

function buildFloorStatePayload(roomId) {
  const social = getSocialState(roomId);
  return {
    floorQueue: social.floorQueue.map((id) => ({
      userId: id,
      name: rooms[roomId]?.[id]?.name || 'Unknown'
    })),
    activeSpeaker: social.activeSpeaker
      ? { userId: social.activeSpeaker, name: rooms[roomId]?.[social.activeSpeaker]?.name || 'Unknown' }
      : null
  };
}

function emitFloorState(roomId, target) {
  (target || io.to(roomId)).emit('floor-state', buildFloorStatePayload(roomId));
}

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('join', (data) => {
    const roomId = data.roomId || 'default';

    const safeName = typeof data.name === 'string' ? data.name.trim().slice(0, 30) : '';
    if (!safeName) {
      console.log(`[server] join rejected for ${socket.id}: invalid name`);
      socket.emit('join-error', { error: 'A valid display name is required to join.' });
      return;
    }

    socket.join(roomId);
    socketRoom.set(socket.id, roomId);

    if (!rooms[roomId]) rooms[roomId] = {};

    const user = {
      userId: socket.id,
      roomId,
      name: safeName,
      avatar: data.avatar || '/assets/useravatar/avatars/UserAvatar.glb',
      position: data.position || [0, 0, 0],
      rotation: data.rotation || [0, 0, 0],
      animation: data.animation || 'Idle',
      timestamp: Date.now()
    };

    rooms[roomId][socket.id] = user;
    const members = Object.keys(rooms[roomId]);
    console.log(`[server] join: ${socket.id} joined room '${roomId}' (members: ${members.length})`);

    socket.broadcast.to(roomId).emit('user-joined', user);
    console.log(`[server] emitted 'user-joined' for ${socket.id} to room ${roomId}`);
    socket.emit('room-state', Object.values(rooms[roomId]).filter((p) => p.userId !== socket.id));
    console.log(`[server] emitted 'room-state' to ${socket.id}:`, Object.values(rooms[roomId]).map((p) => p.userId));
    emitFloorState(roomId, socket);
    const social = getSocialState(roomId);
    if (social.lecturePaused) {
      socket.emit('lecture-control', {
        action: 'pause-for-floor',
        activeSpeaker: { userId: social.activeSpeaker, name: rooms[roomId]?.[social.activeSpeaker]?.name || 'Unknown' }
      });
    }
  });

  socket.on('request-floor', () => {
    const roomId = socketRoom.get(socket.id);
    if (!roomId || !rooms[roomId]?.[socket.id]) return;

    const social = getSocialState(roomId);
    if (social.activeSpeaker === socket.id) return;
    if (social.floorQueue.includes(socket.id)) return;
    social.floorQueue.push(socket.id);
    console.log(`[server] request-floor: ${socket.id} queued in room '${roomId}' (queue: ${social.floorQueue.length})`);
    emitFloorState(roomId);
  });

  socket.on('cancel-floor-request', () => {
    const roomId = socketRoom.get(socket.id);
    if (!roomId) return;

    const social = getSocialState(roomId);
    const idx = social.floorQueue.indexOf(socket.id);
    if (idx === -1) return;
    social.floorQueue.splice(idx, 1);
    console.log(`[server] cancel-floor-request: ${socket.id} removed in room '${roomId}' (queue: ${social.floorQueue.length})`);
    emitFloorState(roomId);
  });

  socket.on('grant-floor', () => {
    const roomId = socketRoom.get(socket.id);
    if (!roomId) return;

    const social = getSocialState(roomId);
    if (social.activeSpeaker !== null) return;
    if (social.floorQueue.length === 0) return;

    social.activeSpeaker = social.floorQueue.shift();
    social.lecturePaused = true;
    social.lecturePausedBy = social.activeSpeaker;
    console.log(`[server] grant-floor: ${social.activeSpeaker} is now active speaker in room '${roomId}'`);
    emitFloorState(roomId);
    io.to(roomId).emit('lecture-control', {
      action: 'pause-for-floor',
      activeSpeaker: { userId: social.activeSpeaker, name: rooms[roomId]?.[social.activeSpeaker]?.name || 'Unknown' }
    });
  });

  socket.on('release-floor', () => {
    const roomId = socketRoom.get(socket.id);
    if (!roomId) return;

    const social = getSocialState(roomId);
    if (social.activeSpeaker !== socket.id) return;

    social.activeSpeaker = null;
    console.log(`[server] release-floor: ${socket.id} released the floor in room '${roomId}'`);
    emitFloorState(roomId);
    if (social.lecturePaused) {
      social.lecturePaused = false;
      social.lecturePausedBy = null;
      io.to(roomId).emit('lecture-control', { action: 'resume' });
    }
  });

  socket.on('ask-floor-question', async (data) => {
    const roomId = socketRoom.get(socket.id);
    if (!roomId || !rooms[roomId]?.[socket.id]) return;

    const social = getSocialState(roomId);
    if (social.activeSpeaker !== socket.id) {
      socket.emit('floor-question-error', { error: 'Only the active speaker can ask a question.' });
      return;
    }

    const question = typeof data?.question === 'string' ? data.question.trim().slice(0, 500) : '';
    if (!question) return;
    if (social.answering) return;
    social.answering = true;

    const askerName = rooms[roomId][socket.id].name;
    io.to(roomId).emit('lecture-control', {
      action: 'answering',
      askedBy: { userId: socket.id, name: askerName },
      question
    });

    try {
      const res = await fetch(`http://localhost:${port}/api/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, lectureId: data.lectureId })
      });
      const json = await res.json();
      if (!res.ok || !json.messages || json.messages.length === 0) {
        throw new Error(json.error || 'Empty answer');
      }
      const msg = json.messages[0];
      io.to(roomId).emit('professor-speak', {
        id: `floor_${socket.id}_${Date.now()}`,
        type: 'answer',
        floorAnswer: true,
        text: msg.text,
        animation: msg.animation,
        facialExpression: msg.facialExpression,
        audioUrl: msg.audioUrl ? `http://localhost:${port}${msg.audioUrl}` : null,
        lipsync: msg.lipsync
      });
    } catch (err) {
      console.error('[server] ask-floor-question failed:', err);
      socket.emit('floor-question-error', { error: 'The professor could not answer right now. Please try again.' });
      io.to(roomId).emit('lecture-control', { action: 'answer-error' });
    } finally {
      social.answering = false;
    }
  });

  socket.on('state-update', (data) => {
    const roomId = socketRoom.get(socket.id);
    if (!roomId || !rooms[roomId]?.[socket.id]) return;

    const user = rooms[roomId][socket.id];
    user.position = data.position;
    user.rotation = data.rotation;
    user.animation = data.animation;
    user.timestamp = Date.now();

    socket.broadcast.to(roomId).emit('state-update', user);
  });

  socket.on('professor-speak', (data) => {
    const roomId = socketRoom.get(socket.id);
    if (!roomId) return;
    console.log(`[server] professor-speak from ${socket.id} to room ${roomId}:`, data?.text);
    io.to(roomId).emit('professor-speak', data);
  });

  socket.on('chat', (data) => {
    const roomId = socketRoom.get(socket.id);
    if (roomId) socket.broadcast.to(roomId).emit('chat', { from: data.name || socket.id, text: data.text });
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    const roomId = socketRoom.get(socket.id);
    if (roomId && rooms[roomId]) {
      delete rooms[roomId][socket.id];
      const social = getSocialState(roomId);
      const idx = social.floorQueue.indexOf(socket.id);
      if (idx !== -1) social.floorQueue.splice(idx, 1);
      if (social.activeSpeaker === socket.id) social.activeSpeaker = null;
      const resumeNeeded = social.lecturePaused && social.lecturePausedBy === socket.id;
      if (resumeNeeded) {
        social.lecturePaused = false;
        social.lecturePausedBy = null;
        social.answering = false;
      }
      const members = Object.keys(rooms[roomId]);
      console.log(`[server] disconnect: ${socket.id} left room '${roomId}' (members: ${members.length})`);
      socket.broadcast.to(roomId).emit('user-left', { userId: socket.id });
      emitFloorState(roomId);
      if (resumeNeeded) io.to(roomId).emit('lecture-control', { action: 'resume' });
      socketRoom.delete(socket.id);
      if (members.length === 0) delete socialStates[roomId];
    }
  });
});

httpServer.listen(port, '0.0.0.0', () => {
  console.log(`Professor Abed is listening on port ${port}`);
});