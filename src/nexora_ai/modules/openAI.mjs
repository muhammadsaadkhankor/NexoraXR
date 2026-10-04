// import { ChatOpenAI } from "@langchain/openai";
// import { ChatPromptTemplate } from "@langchain/core/prompts";
// import { StructuredOutputParser } from "langchain/output_parsers";
// import { z } from "zod";
// import dotenv from "dotenv";

// dotenv.config();

// const template = `
//   You are Professor Abed, an intelligent and friendly AI assitant.
//   You will always respond with a JSON array of messages, with a maximum of 3 messages:
//   \n{format_instructions}.
//   Each message has properties for text, facialExpression, and animation.
//   The different facial expressions are: smile, sad, angry, surprised, funnyFace, and default.
//   The different animations are: Idle, TalkingOne, TalkingThree, SadIdle, Defeated, Angry, 
//   Surprised, DismissingGesture and ThoughtfulHeadShake.
// `;

// const prompt = ChatPromptTemplate.fromMessages([
//   ["ai", template],
//   ["human", "{question}"],
// ]);

// const model = new ChatOpenAI({
//   openAIApiKey: process.env.OPENAI_API_KEY || "-",
//   modelName: process.env.OPENAI_MODEL || "gpt-4", // Changed from "davinci" to "gpt-3.5-turbo"
//   temperature: 0.2,
// });

// const parser = StructuredOutputParser.fromZodSchema(
//   z.object({
//     messages: z.array(
//       z.object({
//         text: z.string().describe("Text to be spoken by the AI"),
//         facialExpression: z
//           .string()
//           .describe(
//             "Facial expression to be used by the AI. Select from: smile, sad, angry, surprised, funnyFace, and default"
//           ),
//         animation: z
//           .string()
//           .describe(
//             `Animation to be used by the AI. Select from: Idle, TalkingOne, TalkingThree, SadIdle, 
//             Defeated, Angry, Surprised, DismissingGesture, and ThoughtfulHeadShake.`
//           ),
//       })
//     ),
//   })
// );

// const openAIChain = prompt.pipe(model).pipe(parser);

// export { openAIChain, parser };



import { ChatOpenAI } from "@langchain/openai";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { StructuredOutputParser } from "langchain/output_parsers";
import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

// Updated template to specify the correct response format
const template = `
  You are Professor Abed, an intelligent and friendly AI assistant.
  You will always respond with a JSON object containing a 'messages' array, with a maximum of 3 messages:
  \n{format_instructions}.
  Each message in the messages array has properties for text, facialExpression, and animation.
  The different facial expressions are: smile, sad, angry, surprised, funnyFace, and default.
  The different animations are: Idle, TalkingOne, TalkingThree, SadIdle, Defeated, Angry, 
  Surprised, DismissingGesture and ThoughtfulHeadShake.
`;

const prompt = ChatPromptTemplate.fromMessages([
  ["ai", template],
  ["human", "{question}"],
]);

const model = new ChatOpenAI({
  openAIApiKey: process.env.OPENAI_API_KEY || "-",
  modelName: process.env.OPENAI_MODEL || "gpt-4",
  temperature: 0.2,
});

const parser = StructuredOutputParser.fromZodSchema(
  z.object({
    messages: z.array(
      z.object({
        text: z.string().describe("Text to be spoken by the AI"),
        facialExpression: z
          .string()
          .describe(
            "Facial expression to be used by the AI. Select from: smile, sad, angry, surprised, funnyFace, and default"
          ),
        animation: z
          .string()
          .describe(
            `Animation to be used by the AI. Select from: Idle, TalkingOne, TalkingThree, SadIdle, 
            Defeated, Angry, Surprised, DismissingGesture, and ThoughtfulHeadShake.`
          ),
      })
    ),
  })
);

const openAIChain = prompt.pipe(model).pipe(parser);

export { openAIChain, parser };