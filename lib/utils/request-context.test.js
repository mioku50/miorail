"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const node_assert_1 = __importDefault(require("node:assert"));
const request_context_js_1 = require("./request-context.js");
(0, node_test_1.default)('requestContext - run and getStore', async () => {
    const result = await request_context_js_1.requestContext.run({ requestId: 'req-1', userId: 'user-A' }, async () => {
        // Simulate async work
        await new Promise(resolve => setTimeout(resolve, 10));
        const store = request_context_js_1.requestContext.getStore();
        return store;
    });
    node_assert_1.default.ok(result);
    node_assert_1.default.strictEqual(result.requestId, 'req-1');
    node_assert_1.default.strictEqual(result.userId, 'user-A');
});
(0, node_test_1.default)('requestContext - isolation between runs', async () => {
    const p1 = request_context_js_1.requestContext.run({ requestId: 'req-1' }, async () => {
        await new Promise(resolve => setTimeout(resolve, 20));
        return request_context_js_1.requestContext.getStore()?.requestId;
    });
    const p2 = request_context_js_1.requestContext.run({ requestId: 'req-2' }, async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return request_context_js_1.requestContext.getStore()?.requestId;
    });
    const [res1, res2] = await Promise.all([p1, p2]);
    node_assert_1.default.strictEqual(res1, 'req-1');
    node_assert_1.default.strictEqual(res2, 'req-2');
});
(0, node_test_1.default)('requestContext - set value', async () => {
    await request_context_js_1.requestContext.run({ requestId: 'req-1' }, async () => {
        request_context_js_1.requestContext.set('userId', 'user-B');
        const store = request_context_js_1.requestContext.getStore();
        node_assert_1.default.strictEqual(store?.requestId, 'req-1');
        node_assert_1.default.strictEqual(store?.userId, 'user-B');
    });
});
