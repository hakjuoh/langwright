import { AzureChatOpenAI } from '@langchain/openai';
import { createAgent, defineConfig } from '@hakjuoh/langwright/config';

const model = process.env.AGENT_MODEL || 'gpt-5.5';

export default defineConfig({
  agent: createAgent({
    model: new AzureChatOpenAI({
      model,
      azureOpenAIApiKey: process.env.AZURE_OPENAI_API_KEY,
      azureOpenAIEndpoint: process.env.AZURE_OPENAI_ENDPOINT,
      azureOpenAIApiVersion: process.env.AZURE_OPENAI_API_VERSION || '2024-10-21',
      azureOpenAIApiDeploymentName: process.env.AZURE_OPENAI_API_DEPLOYMENT_NAME || model,
    }),
  }),
});
