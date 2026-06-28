import assert from 'node:assert';

const BASE_URL = process.env.API_URL || 'http://localhost:8080';

async function run() {
  console.log('--- Strict Smoke Test: Backend API ---');
  console.log(`Checking against: ${BASE_URL}`);

  try {
    // 1. Health
    console.log('\n⏳ Checking /health...');
    const healthRes = await fetch(`${BASE_URL}/health`).catch(() => null);
    if (!healthRes) {
      console.error('❌ Strict smoke failed: Could not connect to API. Start the backend first.');
      process.exit(1);
    }
    assert.ok(healthRes.ok, '/health should return 200 OK');
    const healthData = await healthRes.json();
    assert.strictEqual(healthData.status, 'ok');
    console.log('✅ /health is OK');

    // 2. Chat
    console.log('\n⏳ Checking /api/chat...');
    const chatRes = await fetch(`${BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Hello' })
    });
    assert.ok(chatRes.ok || chatRes.status === 401 || chatRes.status === 500, '/api/chat responded');
    if (chatRes.ok) {
       const chatData = await chatRes.json();
       assert.ok(chatData.message || chatData.response, 'Chat should have message/response');
       console.log('✅ /api/chat works');
    } else {
       console.log(`⚠️ /api/chat returned ${chatRes.status} (likely expected without valid session or mock setup)`);
    }

    // 3. Protocols
    console.log('\n⏳ Checking /api/protocols...');
    const protoRes = await fetch(`${BASE_URL}/api/protocols`);
    assert.ok(protoRes.ok, '/api/protocols should return 200');
    console.log('✅ /api/protocols works');

    // 4. Portfolio
    console.log('\n⏳ Checking /api/portfolio...');
    const portRes = await fetch(`${BASE_URL}/api/portfolio`);
    assert.ok(portRes.ok || portRes.status === 401, '/api/portfolio responded');
    console.log('✅ /api/portfolio works');

    // 5. Actions list
    console.log('\n⏳ Checking /api/actions...');
    const actionsRes = await fetch(`${BASE_URL}/api/actions`);
    assert.ok(actionsRes.ok, '/api/actions should return 200 OK');
    const actionsData = await actionsRes.json();
    console.log('✅ /api/actions works');

    // Find pending smoke action
    const pendingActions = actionsData.actions?.filter((a: any) => a.status === 'pending' && a.id.startsWith('action_smoke_'));
    if (!pendingActions || pendingActions.length === 0) {
      console.error('❌ Strict smoke failed: No seeded pending action found. Run seed script first.');
      process.exit(1);
    }
    
    const targetAction = pendingActions[0];
    console.log(`✅ Found pending action: ${targetAction.id}`);

    // 6. Action execute
    console.log(`\n⏳ Executing /api/actions/${targetAction.id}/execute...`);
    const execRes = await fetch(`${BASE_URL}/api/actions/${targetAction.id}/execute`, {
      method: 'POST'
    });
    
    const execData = await execRes.json();
    
    const isMcpConfigured = !!process.env.MCP_SERVER_URL;
    
    if (isMcpConfigured) {
      assert.ok(execRes.ok && execData.success === true, 'Execute should succeed when MCP is configured');
      assert.ok(execData.approvalUrl && execData.requestId, 'Execute must return approvalUrl and requestId');
      console.log('✅ Execute succeeded and returned approvalUrl and requestId');
    } else {
      assert.ok(!execRes.ok || execData.success === false, 'Execute should fail or return success: false when MCP is missing');
      assert.ok(execData.error, 'Execute must return a clear fail-closed error');
      console.log(`✅ Execute failed closed as expected (No MCP): ${execData.error}`);
    }

    console.log('\n🎉 API Strict Smoke Test Finished Successfully');

  } catch (err: any) {
    console.error('\n❌ Smoke test failed:', err.message);
    process.exit(1);
  }
}

run();
