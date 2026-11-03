import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import http from "node:http";
import Express from "express";

// Read at import time, as the running app reads it.
process.env.WEBHOOK_SECRET = "a-webhook-secret";
// The refusals these tests provoke each log a warn.
process.env.LOG_LEVEL = "silent";

const { WEBHOOK_PATH, WEBHOOK_BODY_LIMIT, guardWebhooks } = await import("../src/services/webhookGuard.js");

/**
 * The guard mounted the way src/index.js mounts it, in front of a stand-in for Probot that
 * records what it was handed
 * @returns {Promise<{server: import('node:http').Server, received: Array<Object>}>}
 */
const guarded = () => new Promise((resolve) => {
  const received = [];
  const express = Express();

  express.post(WEBHOOK_PATH, guardWebhooks);
  express.use((req, res) => {
    received.push({ body: req.body, rawBody: req.rawBody });
    res.status(200).send('ok\n');
  });

  const server = express.listen(0, '127.0.0.1', () => resolve({ server, received }));
});

const signatureOf = (body, secret = process.env.WEBHOOK_SECRET) =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

/**
 * One POST, with a body either sent whole or streamed in 1 MB chunks with no declared length
 * @param {import('node:http').Server} server
 * @param {{body?: Buffer, headers?: Object, streamed?: number}} request - `streamed` is a byte
 *   count, sent instead of `body`
 * @returns {Promise<number>} The status
 */
const post = (server, { body = Buffer.alloc(0), headers = {}, streamed = 0 }) => new Promise((resolve, reject) => {
  const request = http.request({
    host: '127.0.0.1',
    port: server.address().port,
    path: WEBHOOK_PATH,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(streamed ? { 'transfer-encoding': 'chunked' } : { 'content-length': body.length }),
      ...headers,
    },
  }, (response) => {
    response.resume();
    response.on('end', () => resolve(response.statusCode));
  });

  // The server may cut the connection before the whole body is written, which is the point.
  request.on('error', (error) => (error.code === 'ECONNRESET' || error.code === 'EPIPE' ? null : reject(error)));

  if (streamed) {
    const chunk = Buffer.alloc(1024 * 1024, 0x20);

    for (let sent = 0; sent < streamed; sent += chunk.length) {
      request.write(chunk);
    }
  } else {
    request.write(body);
  }

  request.end();
});

describe("the webhook endpoint, before Probot reads it", () => {
  test("a genuine delivery reaches Probot with its body already read, in the form it accepts", async (t) => {
    const { server, received } = await guarded();

    t.after(() => server.close());

    const body = Buffer.from('{"action":"created"}');
    const status = await post(server, { body, headers: { 'x-hub-signature-256': signatureOf(body) } });

    assert.equal(status, 200);
    assert.equal(received.length, 1);
    // @octokit/webhooks reads a body already consumed only from an object `body` beside a
    // `rawBody` of bytes; anything else and it waits on a stream that has already ended.
    assert.ok(received[0].rawBody instanceof Uint8Array);
    assert.equal(typeof received[0].body, 'object');
    assert.equal(Buffer.from(received[0].rawBody).toString('utf8'), '{"action":"created"}');
  });

  test("a delivery signed with another secret, or not signed, never reaches Probot", async (t) => {
    const { server, received } = await guarded();

    t.after(() => server.close());

    const body = Buffer.from('{"action":"created"}');

    for (const headers of [{ 'x-hub-signature-256': signatureOf(body, 'another-secret') }, {}, { 'x-hub-signature-256': 'sha256=' }]) {
      assert.equal(await post(server, { body, headers }), 400, JSON.stringify(headers));
    }

    assert.deepEqual(received, [], 'an unsigned body reached the library that logs it');
  });

  test("a body declared above GitHub's 25 MB is refused before a byte is read", async (t) => {
    const { server, received } = await guarded();

    t.after(() => server.close());

    // Declared, never sent: body-parser answers on the header alone.
    const status = await new Promise((resolve, reject) => {
      const request = http.request({
        host: '127.0.0.1',
        port: server.address().port,
        path: WEBHOOK_PATH,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': WEBHOOK_BODY_LIMIT + 1 },
      }, (response) => {
        response.resume();
        resolve(response.statusCode);
      });

      request.on('error', reject);
      request.flushHeaders();
    });

    assert.equal(status, 413);
    assert.deepEqual(received, []);
  });

  test("and so is one that only crosses it while streaming", async (t) => {
    // No Content-Length to refuse on: the cap has to hold on the bytes themselves.
    const { server, received } = await guarded();

    t.after(() => server.close());

    const status = await post(server, { streamed: WEBHOOK_BODY_LIMIT + 1024 * 1024 });

    assert.equal(status, 413);
    assert.deepEqual(received, []);
  });
});
