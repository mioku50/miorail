import test from 'node:test';
import assert from 'node:assert';
import { createServer, type AddressInfo } from 'node:net';

import { resolveBindV1, startServer } from './index';

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

// The API server runs behind nginx, which terminates TLS and proxies to
// 127.0.0.1. Express's `listen(port)` with no host binds every interface, so
// the production process was also answering on the public IP beside the proxy —
// the same routes, but without the proxy's security headers and on a port no
// certificate covers. These pin the loopback default so it cannot regress
// silently: nothing about a missing argument announces itself at runtime.
test('resolveBindV1', async (t) => {
  await t.test('defaults to loopback when HOST is unset', () => {
    assert.strictEqual(resolveBindV1({ PORT: '8080' }).host, '127.0.0.1');
  });

  await t.test('treats an empty HOST as unset rather than as every interface', () => {
    // `app.listen(port, '')` binds 0.0.0.0. A blank line in an env file must not
    // be the difference between private and public.
    assert.strictEqual(resolveBindV1({ HOST: '' }).host, '127.0.0.1');
  });

  await t.test('honours an explicit HOST', () => {
    assert.strictEqual(resolveBindV1({ HOST: '0.0.0.0' }).host, '0.0.0.0');
  });

  await t.test('defaults the port to 3000', () => {
    assert.strictEqual(resolveBindV1({}).port, 3000);
  });

  await t.test('treats an empty or unparseable PORT as unset, not as port 0', () => {
    // `Number('')` is 0, and `listen(0)` asks the OS for a random port — the
    // service would come up healthy on a port nginx does not proxy.
    assert.strictEqual(resolveBindV1({ PORT: '' }).port, 3000);
    assert.strictEqual(resolveBindV1({ PORT: 'not-a-port' }).port, 3000);
    assert.strictEqual(resolveBindV1({ PORT: '0' }).port, 3000);
  });

  await t.test('parses a configured port', () => {
    assert.strictEqual(resolveBindV1({ PORT: '8080' }).port, 8080);
  });
});

test('startServer', async (t) => {
  await t.test('binds to loopback by default', async () => {
    const originalHost = process.env.HOST;
    const originalPort = process.env.PORT;
    delete process.env.HOST;
    // `PORT=0` is deliberately rejected by resolveBindV1, so ask the OS for a
    // free port up front and hand that concrete number to the server.
    process.env.PORT = String(await findFreePort());

    const server = startServer();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('listening', () => resolve());
        server.once('error', reject);
      });

      const address = server.address() as AddressInfo | null;
      assert.ok(address, 'server should report an address once listening');
      assert.strictEqual(
        address.address,
        '127.0.0.1',
        'API must not bind a public interface — nginx is the only intended entry point',
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (originalHost === undefined) delete process.env.HOST;
      else process.env.HOST = originalHost;
      if (originalPort === undefined) delete process.env.PORT;
      else process.env.PORT = originalPort;
    }
  });
});
