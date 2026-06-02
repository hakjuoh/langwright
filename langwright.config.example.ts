import { ChatOpenAI } from '@langchain/openai';
import { createAgent, defineConfig } from '@hakjuoh/langwright/config';

/*
 * Langwright config examples for LangChain.js chat-model providers.
 *
 * Pick one provider block, install its package, uncomment its import, and pass
 * the selected model to `createAgent({ model })`.
 *
 * Langwright requires a chat model that supports tool calling because browser
 * actions are exposed to the agent as the `playwright_run` tool.
 *
 * Model fallbacks below intentionally prefer current frontier/tool-capable
 * models over cost-optimized defaults. Keep the environment-variable overrides
 * in place because provider catalogs, regions, and account entitlements change
 * quickly.
 */

// ---------------------------------------------------------------------------
// OpenAI
// npm install @langchain/openai
// ---------------------------------------------------------------------------
const model = new ChatOpenAI({
  model: process.env.OPENAI_MODEL || 'gpt-5.5',
  apiKey: process.env.OPENAI_API_KEY,
});

// ---------------------------------------------------------------------------
// Azure OpenAI
// npm install @langchain/openai
// ---------------------------------------------------------------------------
// import { AzureChatOpenAI } from '@langchain/openai';
//
// const model = new AzureChatOpenAI({
//   model: process.env.AGENT_MODEL || 'gpt-5.5',
//   azureOpenAIApiKey: process.env.AZURE_OPENAI_API_KEY,
//   azureOpenAIEndpoint: process.env.AZURE_OPENAI_ENDPOINT,
//   azureOpenAIApiVersion: process.env.AZURE_OPENAI_API_VERSION || '2024-10-21',
//   azureOpenAIApiDeploymentName:
//     process.env.AZURE_OPENAI_API_DEPLOYMENT_NAME || process.env.AGENT_MODEL || 'gpt-5.5',
// });

// ---------------------------------------------------------------------------
// Anthropic
// npm install @langchain/anthropic
// ---------------------------------------------------------------------------
// import { ChatAnthropic } from '@langchain/anthropic';
//
// const model = new ChatAnthropic({
//   model: process.env.ANTHROPIC_MODEL || 'claude-opus-4-8',
//   apiKey: process.env.ANTHROPIC_API_KEY,
// });

// ---------------------------------------------------------------------------
// Google Gemini Developer API
// npm install @langchain/google-genai
// ---------------------------------------------------------------------------
// import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
//
// const model = new ChatGoogleGenerativeAI({
//   model: process.env.GOOGLE_MODEL || 'gemini-3.1-pro-preview',
//   apiKey: process.env.GOOGLE_API_KEY,
// });

// ---------------------------------------------------------------------------
// Google Vertex AI
// npm install @langchain/google-vertexai
// ---------------------------------------------------------------------------
// import { ChatVertexAI } from '@langchain/google-vertexai';
//
// const model = new ChatVertexAI({
//   model: process.env.VERTEXAI_MODEL || 'gemini-3.1-pro-preview',
//   location: process.env.GOOGLE_CLOUD_LOCATION || 'us-central1',
// });

// ---------------------------------------------------------------------------
// AWS Bedrock Converse
// npm install @langchain/aws
// ---------------------------------------------------------------------------
// import { ChatBedrockConverse } from '@langchain/aws';
//
// const model = new ChatBedrockConverse({
//   model: process.env.BEDROCK_MODEL || 'global.anthropic.claude-opus-4-8',
//   region: process.env.BEDROCK_AWS_REGION || process.env.AWS_REGION || 'us-east-1',
// });

// ---------------------------------------------------------------------------
// Mistral AI
// npm install @langchain/mistralai
// ---------------------------------------------------------------------------
// import { ChatMistralAI } from '@langchain/mistralai';
//
// const model = new ChatMistralAI({
//   model: process.env.MISTRAL_MODEL || 'mistral-medium-3-5',
//   apiKey: process.env.MISTRAL_API_KEY,
// });

// ---------------------------------------------------------------------------
// Groq
// npm install @langchain/groq
// ---------------------------------------------------------------------------
// import { ChatGroq } from '@langchain/groq';
//
// const model = new ChatGroq({
//   model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
//   apiKey: process.env.GROQ_API_KEY,
// });

// ---------------------------------------------------------------------------
// Cohere
// npm install @langchain/cohere
// ---------------------------------------------------------------------------
// import { ChatCohere } from '@langchain/cohere';
//
// const model = new ChatCohere({
//   model: process.env.COHERE_MODEL || 'command-a-plus-05-2026',
//   apiKey: process.env.COHERE_API_KEY,
// });

// ---------------------------------------------------------------------------
// DeepSeek
// npm install @langchain/deepseek
// ---------------------------------------------------------------------------
// import { ChatDeepSeek } from '@langchain/deepseek';
//
// const model = new ChatDeepSeek({
//   model: process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro',
//   apiKey: process.env.DEEPSEEK_API_KEY,
// });

// ---------------------------------------------------------------------------
// xAI
// npm install @langchain/xai
// ---------------------------------------------------------------------------
// import { ChatXAI } from '@langchain/xai';
//
// const model = new ChatXAI({
//   model: process.env.XAI_MODEL || 'grok-4.3',
//   apiKey: process.env.XAI_API_KEY,
// });

// ---------------------------------------------------------------------------
// OpenRouter
// npm install @langchain/openrouter
// ---------------------------------------------------------------------------
// import { ChatOpenRouter } from '@langchain/openrouter';
//
// const model = new ChatOpenRouter({
//   model: process.env.OPENROUTER_MODEL || 'openai/gpt-5.5',
//   apiKey: process.env.OPENROUTER_API_KEY,
// });

// ---------------------------------------------------------------------------
// Ollama
// npm install @langchain/ollama
// ---------------------------------------------------------------------------
// import { ChatOllama } from '@langchain/ollama';
//
// const model = new ChatOllama({
//   model: process.env.OLLAMA_MODEL || 'qwen3:235b',
//   baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
// });

// ---------------------------------------------------------------------------
// Together AI
// npm install @langchain/community
// ---------------------------------------------------------------------------
// import { ChatTogetherAI } from '@langchain/community/chat_models/togetherai';
//
// const model = new ChatTogetherAI({
//   model: process.env.TOGETHER_AI_MODEL || 'Qwen/Qwen3-235B-A22B-fp8-tput',
//   apiKey: process.env.TOGETHER_AI_API_KEY,
// });

// ---------------------------------------------------------------------------
// Fireworks AI
// npm install @langchain/community
// ---------------------------------------------------------------------------
// import { ChatFireworks } from '@langchain/community/chat_models/fireworks';
//
// const model = new ChatFireworks({
//   model: process.env.FIREWORKS_MODEL || 'accounts/fireworks/models/qwen3-235b-a22b-instruct-2507',
//   apiKey: process.env.FIREWORKS_API_KEY,
// });

// ---------------------------------------------------------------------------
// Generic OpenAI-compatible endpoint
// npm install @langchain/openai
// ---------------------------------------------------------------------------
// const model = new ChatOpenAI({
//   model: process.env.OPENAI_COMPATIBLE_MODEL || 'gpt-5.5',
//   apiKey: process.env.OPENAI_COMPATIBLE_API_KEY,
//   configuration: {
//     baseURL: process.env.OPENAI_COMPATIBLE_BASE_URL,
//   },
// });

export default defineConfig({
  // `agentName` defaults to "langwright-agent".
  // `agentVersion` defaults to the Langwright package version.
  // Override either field here only when you want custom trajectory metadata.
  agent: createAgent({ model }),
});
