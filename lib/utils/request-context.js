"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requestContext = void 0;
const node_async_hooks_1 = require("node:async_hooks");
const asyncLocalStorage = new node_async_hooks_1.AsyncLocalStorage();
exports.requestContext = {
    run: (data, callback) => {
        return asyncLocalStorage.run(data, callback);
    },
    get: () => {
        return asyncLocalStorage.getStore();
    },
    getStore: () => {
        return asyncLocalStorage.getStore();
    },
    set: (key, value) => {
        const store = asyncLocalStorage.getStore();
        if (store) {
            store[key] = value;
        }
    }
};
