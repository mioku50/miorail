"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const node_assert_1 = __importDefault(require("node:assert"));
const rate_limit_js_1 = require("./rate-limit.js");
(0, node_test_1.default)('InMemoryRateLimiter - consume tokens successfully', async () => {
    const limiter = new rate_limit_js_1.InMemoryRateLimiter({ windowMs: 1000, max: 2 });
    const res1 = await limiter.consume('user-1');
    node_assert_1.default.strictEqual(res1.success, true);
    node_assert_1.default.strictEqual(res1.remaining, 1);
    const res2 = await limiter.consume('user-1');
    node_assert_1.default.strictEqual(res2.success, true);
    node_assert_1.default.strictEqual(res2.remaining, 0);
});
(0, node_test_1.default)('InMemoryRateLimiter - reject when limit exceeded', async () => {
    const limiter = new rate_limit_js_1.InMemoryRateLimiter({ windowMs: 1000, max: 1 });
    const res1 = await limiter.consume('user-2');
    node_assert_1.default.strictEqual(res1.success, true);
    const res2 = await limiter.consume('user-2');
    node_assert_1.default.strictEqual(res2.success, false);
    node_assert_1.default.strictEqual(res2.remaining, 0);
});
(0, node_test_1.default)('InMemoryRateLimiter - isolation between keys', async () => {
    const limiter = new rate_limit_js_1.InMemoryRateLimiter({ windowMs: 1000, max: 1 });
    const res1 = await limiter.consume('user-3');
    node_assert_1.default.strictEqual(res1.success, true);
    const res2 = await limiter.consume('user-4');
    node_assert_1.default.strictEqual(res2.success, true);
});
(0, node_test_1.default)('InMemoryRateLimiter - reset after window expires', async () => {
    const limiter = new rate_limit_js_1.InMemoryRateLimiter({ windowMs: 50, max: 1 });
    const res1 = await limiter.consume('user-5');
    node_assert_1.default.strictEqual(res1.success, true);
    const res2 = await limiter.consume('user-5');
    node_assert_1.default.strictEqual(res2.success, false);
    // Wait for window to expire
    await new Promise(resolve => setTimeout(resolve, 60));
    const res3 = await limiter.consume('user-5');
    node_assert_1.default.strictEqual(res3.success, true);
});
(0, node_test_1.default)('InMemoryRateLimiter - cleanup removes expired records', async () => {
    const limiter = new rate_limit_js_1.InMemoryRateLimiter({ windowMs: 50, max: 1 });
    await limiter.consume('user-6');
    // Wait for window to expire
    await new Promise(resolve => setTimeout(resolve, 60));
    limiter.cleanup();
    // Since it's private, we can't assert on store size directly easily without casting
    // @ts-expect-error Accessing private property for testing
    const storeSize = limiter.store.size;
    node_assert_1.default.strictEqual(storeSize, 0);
});
