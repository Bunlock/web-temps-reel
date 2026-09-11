import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatModule } from '../src/chat-module.js';
import { DomainError } from '../src/contracts.js';

function fixture(options = {}) {
  let sequence = 0;
  let now = 1_700_000_000_000;
  const chat = new ChatModule({
    newId: () => `generated-${String(++sequence).padStart(24, '0')}`,
    now: () => now,
    ...options,
  });
  const connect = (socketId, nickname, sessionToken) => chat.connect(socketId, {
    nickname,
    ...(sessionToken ? { sessionToken } : {}),
  });
  return {
    chat,
    connect,
    advance(milliseconds) { now += milliseconds; },
  };
}

function joinPair(roomId = 'ALPHA') {
  const value = fixture();
  const alice = value.connect('socket-alice', 'Alice');
  const bob = value.connect('socket-bob', 'Bob');
  value.chat.join(alice.player.playerId, { roomId });
  value.chat.join(bob.player.playerId, { roomId });
  return { ...value, alice, bob, roomId };
}

test('the server owns membership and message authorship', () => {
  const { chat, alice, bob, roomId } = joinPair();
  const outsider = chat.connect('socket-eve', { nickname: 'Eve' });

  assert.throws(
    () => chat.postMessage(outsider.player.playerId, { clientMessageId: 'eve-1', content: 'spy' }),
    (error) => error instanceof DomainError && error.code === 'CHAT_NOT_AVAILABLE',
  );
  assert.throws(
    () => chat.postMessage(alice.player.playerId, {
      clientMessageId: 'alice-1',
      content: 'hello',
      nickname: 'Mallory',
    }),
    (error) => error instanceof DomainError && error.code === 'INVALID_MESSAGE',
  );

  const result = chat.postMessage(alice.player.playerId, {
    clientMessageId: 'alice-1',
    content: '  Hello Bob  ',
  });
  assert.equal(result.roomId, roomId);
  assert.deepEqual(result.message, {
    messageId: 'generated-000000000000000000000007',
    clientMessageId: 'alice-1',
    playerId: alice.player.playerId,
    nickname: 'Alice',
    content: 'Hello Bob',
    sentAt: new Date(1_700_000_000_000).toISOString(),
  });
  assert.deepEqual(chat.chatSnapshot(bob.player.playerId).messages, [result.message]);
});

test('client message ids make accepted commands idempotent', () => {
  const { chat, alice } = joinPair();
  const command = { clientMessageId: 'same-command', content: 'Only once' };

  const first = chat.postMessage(alice.player.playerId, command);
  const repeated = chat.postMessage(alice.player.playerId, command);

  assert.equal(first.duplicate, false);
  assert.equal(repeated.duplicate, true);
  assert.equal(repeated.message.messageId, first.message.messageId);
  assert.equal(chat.chatSnapshot(alice.player.playerId).messages.length, 1);
});

test('history is bounded and ordered', () => {
  const { chat, alice } = joinPair();
  chat.historyLimit = 2;

  chat.postMessage(alice.player.playerId, { clientMessageId: 'one', content: 'One' });
  chat.postMessage(alice.player.playerId, { clientMessageId: 'two', content: 'Two' });
  chat.postMessage(alice.player.playerId, { clientMessageId: 'three', content: 'Three' });

  assert.deepEqual(
    chat.chatSnapshot(alice.player.playerId).messages.map(({ content }) => content),
    ['Two', 'Three'],
  );
});

test('rate limiting applies per player and resets with time', () => {
  const value = joinPair();
  value.chat.rateLimit = 2;
  value.chat.rateWindowMs = 1_000;

  value.chat.postMessage(value.alice.player.playerId, { clientMessageId: 'one', content: 'One' });
  value.chat.postMessage(value.alice.player.playerId, { clientMessageId: 'two', content: 'Two' });
  assert.throws(
    () => value.chat.postMessage(value.alice.player.playerId, { clientMessageId: 'three', content: 'Three' }),
    (error) => error instanceof DomainError && error.code === 'CHAT_RATE_LIMITED',
  );
  value.advance(1_001);
  assert.doesNotThrow(() => value.chat.postMessage(
    value.alice.player.playerId,
    { clientMessageId: 'four', content: 'Four' },
  ));
});

test('room history carries into battle and becomes unavailable after completion', () => {
  const { chat, alice, bob, roomId } = joinPair();
  chat.postMessage(alice.player.playerId, { clientMessageId: 'before', content: 'Ready?' });

  assert.equal(chat.startMatch(alice.player.playerId).phase, 'battle');
  assert.equal(chat.chatSnapshot(bob.player.playerId).messages[0].content, 'Ready?');
  assert.equal(chat.finishMatch(alice.player.playerId).phase, 'finished');
  assert.deepEqual(chat.chatSnapshot(bob.player.playerId), { messages: [] });
  assert.equal(chat.roomState(roomId).phase, 'finished');
  assert.throws(
    () => chat.postMessage(bob.player.playerId, { clientMessageId: 'after', content: 'Good game' }),
    (error) => error instanceof DomainError && error.code === 'CHAT_READ_ONLY',
  );
});

test('a session can reclaim match membership and replaces its older socket', () => {
  const { chat, alice, roomId } = joinPair();
  chat.disconnect(alice.player.playerId, 'socket-alice');

  const resumed = chat.connect('socket-alice-new', {
    nickname: 'Forged name',
    sessionToken: alice.sessionToken,
  });

  assert.equal(resumed.player.nickname, 'Alice');
  assert.equal(resumed.roomId, roomId);
  assert.throws(
    () => chat.ensureCurrentConnection(alice.player.playerId, 'socket-alice'),
    (error) => error instanceof DomainError && error.code === 'STALE_CONNECTION',
  );
  assert.doesNotThrow(() => chat.ensureCurrentConnection(alice.player.playerId, 'socket-alice-new'));
});

test('an expired lobby host closes the room for every remaining participant', () => {
  const { chat, alice, bob, roomId } = joinPair();
  chat.disconnect(alice.player.playerId, 'socket-alice');

  const removal = chat.expireDisconnected(alice.player.playerId);

  assert.equal(removal.closed, true);
  assert.equal(chat.roomState(roomId), null);
  assert.equal(chat.sessionRoomId(bob.player.playerId), null);
});
