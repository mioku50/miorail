import test from 'node:test';
import assert from 'node:assert';
import { Logger } from './logger.js';

test('Logger - JSON format', () => {
  const logs: string[] = [];
  const originalLog = console.info;

  console.info = (msg: string) => {
    logs.push(msg);
  };

  try {
    const logger = new Logger({ app: 'test' }, 'json');
    logger.info('test message', { userId: '123' });

    assert.strictEqual(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assert.strictEqual(parsed.level, 'info');
    assert.strictEqual(parsed.message, 'test message');
    assert.strictEqual(parsed.app, 'test');
    assert.strictEqual(parsed.userId, '123');
    assert.ok(parsed.timestamp);
  } finally {
    console.info = originalLog;
  }
});

test('Logger - Text format', () => {
  const logs: string[] = [];
  const originalLog = console.info;

  console.info = (msg: string) => {
    logs.push(msg);
  };

  try {
    const logger = new Logger({ app: 'test' }, 'text');
    logger.info('test message', { userId: '123' });

    assert.strictEqual(logs.length, 1);
    assert.ok(logs[0].includes('INFO: test message'));
    assert.ok(logs[0].includes('app="test"'));
    assert.ok(logs[0].includes('userId="123"'));
  } finally {
    console.info = originalLog;
  }
});

test('Logger - Child logger context inheritance', () => {
  const logs: string[] = [];
  const originalLog = console.info;

  console.info = (msg: string) => {
    logs.push(msg);
  };

  try {
    const parentLogger = new Logger({ app: 'test' }, 'json');
    const childLogger = parentLogger.child({ module: 'auth' });

    childLogger.info('login success');

    assert.strictEqual(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assert.strictEqual(parsed.app, 'test');
    assert.strictEqual(parsed.module, 'auth');
  } finally {
    console.info = originalLog;
  }
});
