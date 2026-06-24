import test from 'node:test';
import assert from 'node:assert';
import { SepoliaToolProvider } from '../src/sepolia.js';

test('SepoliaToolProvider lists tools', async () => {
  const provider = new SepoliaToolProvider();
  const tools = await provider.listTools();
  assert.strictEqual(tools.length, 2);
  assert.strictEqual(tools[0].name, 'sepolia_get_balance');
  assert.strictEqual(tools[1].name, 'sepolia_get_transaction');
});

test('SepoliaToolProvider finds tool', () => {
  const provider = new SepoliaToolProvider();
  const tool = provider.findTool('sepolia_get_balance');
  assert.ok(tool);
  assert.strictEqual(tool.name, 'sepolia_get_balance');
});
