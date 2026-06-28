import { createLlmProvider } from '../lib/llm/src/factory.js';


// If needed, run with: node --env-file=.env scripts/smoke_runtime.ts

async function run() {
  console.log('--- Smoke Test: LLM Runtime ---');
  
  if (process.env.LLM_PROVIDER !== 'openai-compatible') {
    console.error('❌ LLM_PROVIDER must be openai-compatible');
    process.exit(1);
  }

  if (!process.env.LLM_BASE_URL || !process.env.LLM_API_KEY || !process.env.LLM_MODEL) {
    console.error('❌ LLM_BASE_URL, LLM_API_KEY, LLM_MODEL must be set');
    process.exit(1);
  }

  console.log('✅ Provider:', process.env.LLM_PROVIDER);
  console.log('✅ Base URL:', process.env.LLM_BASE_URL);
  console.log('✅ Model:', process.env.LLM_MODEL);
  console.log('✅ API Key is set (hidden)');

  try {
    const provider = createLlmProvider();
    console.log('✅ Provider factory instantiated successfully');

    // Attempt a completion
    console.log('⏳ Requesting completion from LLM...');
    const res = await provider.generate({
      messages: [{ role: 'user', content: 'Say "hello sepolia" in lowercase.' }]
    });

    if (res && res.message && res.message.content) {
      console.log('✅ LLM response received:', res.message.content.trim());
      console.log('🎉 LLM Runtime Smoke Test Passed!');
    } else {
      console.error('❌ LLM returned empty or invalid response:', res);
      process.exit(1);
    }
  } catch (err: any) {
    // ensure no API key is printed
    const errMsg = err.message || err.toString();
    if (errMsg.includes(process.env.LLM_API_KEY)) {
      console.error('❌ SECURITY FAILURE: API Key leaked in error message!');
    } else {
      console.error('❌ Error during LLM generation:', errMsg);
    }
    process.exit(1);
  }
}

run();
