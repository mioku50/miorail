/** Stop waiting when a caller leaves, and never start work after cancellation.
 * Providers should also receive the signal: a race alone cannot stop remote work. */
export async function abortableV1<T>(signal: AbortSignal | undefined, work: () => PromiseLike<T> | T): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return await work();
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => { cleanup(); reject(signal.reason); };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(() => {
      signal.throwIfAborted();
      return work();
    }).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}
