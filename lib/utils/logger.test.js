"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const node_assert_1 = __importDefault(require("node:assert"));
const logger_js_1 = require("./logger.js");
(0, node_test_1.default)('Logger - JSON format', () => {
    const logs = [];
    const originalLog = console.info;
    console.info = (msg) => {
        logs.push(msg);
    };
    try {
        const logger = new logger_js_1.Logger({ app: 'test' }, 'json');
        logger.info('test message', { userId: '123' });
        node_assert_1.default.strictEqual(logs.length, 1);
        const parsed = JSON.parse(logs[0]);
        node_assert_1.default.strictEqual(parsed.level, 'info');
        node_assert_1.default.strictEqual(parsed.message, 'test message');
        node_assert_1.default.strictEqual(parsed.app, 'test');
        node_assert_1.default.strictEqual(parsed.userId, '123');
        node_assert_1.default.ok(parsed.timestamp);
    }
    finally {
        console.info = originalLog;
    }
});
(0, node_test_1.default)('Logger - Text format', () => {
    const logs = [];
    const originalLog = console.info;
    console.info = (msg) => {
        logs.push(msg);
    };
    try {
        const logger = new logger_js_1.Logger({ app: 'test' }, 'text');
        logger.info('test message', { userId: '123' });
        node_assert_1.default.strictEqual(logs.length, 1);
        node_assert_1.default.ok(logs[0].includes('INFO: test message'));
        node_assert_1.default.ok(logs[0].includes('app="test"'));
        node_assert_1.default.ok(logs[0].includes('userId="123"'));
    }
    finally {
        console.info = originalLog;
    }
});
(0, node_test_1.default)('Logger - Child logger context inheritance', () => {
    const logs = [];
    const originalLog = console.info;
    console.info = (msg) => {
        logs.push(msg);
    };
    try {
        const parentLogger = new logger_js_1.Logger({ app: 'test' }, 'json');
        const childLogger = parentLogger.child({ module: 'auth' });
        childLogger.info('login success');
        node_assert_1.default.strictEqual(logs.length, 1);
        const parsed = JSON.parse(logs[0]);
        node_assert_1.default.strictEqual(parsed.app, 'test');
        node_assert_1.default.strictEqual(parsed.module, 'auth');
    }
    finally {
        console.info = originalLog;
    }
});
