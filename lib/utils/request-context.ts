import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContextData {
  requestId: string;
  userId?: string;
  [key: string]: unknown;
}

const asyncLocalStorage = new AsyncLocalStorage<RequestContextData>();

export const requestContext = {
  run: <R>(data: RequestContextData, callback: () => R): R => {
    return asyncLocalStorage.run(data, callback);
  },

  get: (): RequestContextData | undefined => {
    return asyncLocalStorage.getStore();
  },

  getStore: (): RequestContextData | undefined => {
    return asyncLocalStorage.getStore();
  },

  set: (key: string, value: unknown): void => {
    const store = asyncLocalStorage.getStore();
    if (store) {
      store[key] = value;
    }
  }
};
