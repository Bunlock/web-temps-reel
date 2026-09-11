import test from 'node:test';
import assert from 'node:assert/strict';
import { io as createClient } from 'socket.io-client';
import { createChatServer, sameOriginAllowed } from '../src/server.js';

test('Socket.IO acknowledgements and rooms isolate match chat', async (context) => {
  const server = createChatServer({ reconnectGraceMs: 40 });
  const address = await server.listen();
  const url = `http://127.0.0.1:${address.port}`;
  const clients = [];
  context.after(async () => {
    for (const client of clients) client.disconnect();
    await server.close();
  });

  const alice = await connect(url, 'Alice');
  const bob = await connect(url, 'Bob');
  const eve = await connect(url, 'Eve');
  clients.push(alice.socket, bob.socket, eve.socket);

  assert.equal((await emitAck(alice.socket, 'match:join', { roomId: 'ALPHA' })).accepted, true);
  assert.equal((await emitAck(bob.socket, 'match:join', { roomId: 'ALPHA' })).accepted, true);
  assert.equal((await emitAck(eve.socket, 'match:join', { roomId: 'BRAVO' })).accepted, true);

  const receivedByBob = onceEvent(bob.socket, 'chat:message:created');
  let receivedByEve = false;
  eve.socket.once('chat:message:created', () => { receivedByEve = true; });
  const acknowledgement = await emitAck(alice.socket, 'chat:message:create', {
    clientMessageId: 'alice-command-1',
    content: 'Room alpha only',
  });

  assert.deepEqual(acknowledgement, {
    accepted: true,
    messageId: acknowledgement.messageId,
    duplicate: false,
  });
  const delivered = await receivedByBob;
  assert.equal(delivered.nickname, 'Alice');
  assert.equal(delivered.content, 'Room alpha only');
  await delay(50);
  assert.equal(receivedByEve, false);
});

test('the gateway rejects unknown fields and makes completed chat read-only', async (context) => {
  const server = createChatServer();
  const address = await server.listen();
  const url = `http://127.0.0.1:${address.port}`;
  const alice = await connect(url, 'Alice');
  const bob = await connect(url, 'Bob');
  context.after(async () => {
    alice.socket.disconnect();
    bob.socket.disconnect();
    await server.close();
  });

  await emitAck(alice.socket, 'match:join', { roomId: 'FINAL' });
  await emitAck(bob.socket, 'match:join', { roomId: 'FINAL' });
  assert.equal((await emitAck(alice.socket, 'match:start', {})).phase, 'battle');

  const malformed = await emitAck(alice.socket, 'chat:message:create', {
    clientMessageId: 'bad-command',
    content: 'Hello',
    playerId: bob.session.player.playerId,
  });
  assert.equal(malformed.accepted, false);
  assert.equal(malformed.errorCode, 'INVALID_MESSAGE');

  assert.equal((await emitAck(alice.socket, 'match:finish', {})).phase, 'finished');
  const after = await emitAck(bob.socket, 'chat:message:create', {
    clientMessageId: 'too-late',
    content: 'Good game',
  });
  assert.equal(after.accepted, false);
  assert.equal(after.errorCode, 'CHAT_READ_ONLY');
});

test('browser origin validation allows same-origin and rejects cross-origin requests', () => {
  assert.equal(sameOriginAllowed(undefined, '127.0.0.1:4567'), true);
  assert.equal(sameOriginAllowed('http://127.0.0.1:4567', '127.0.0.1:4567'), true);
  assert.equal(sameOriginAllowed('https://untrusted.example', '127.0.0.1:4567'), false);
  assert.equal(sameOriginAllowed('not a URL', '127.0.0.1:4567'), false);
});

async function connect(url, nickname) {
  const socket = createClient(url, {
    auth: { nickname },
    forceNew: true,
    transports: ['websocket'],
  });
  const session = await onceEvent(socket, 'session:ready');
  return { socket, session };
}

function emitAck(socket, event, payload) {
  return new Promise((resolve, reject) => {
    socket.timeout(1_000).emit(event, payload, (error, reply) => {
      if (error) reject(error);
      else resolve(reply);
    });
  });
}

function onceEvent(socket, event) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), 1_000);
    socket.once(event, (payload) => {
      clearTimeout(timeout);
      resolve(payload);
    });
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
