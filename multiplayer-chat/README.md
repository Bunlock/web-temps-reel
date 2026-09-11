# Multiplayer Chat Teaching Lab

This directory is a standalone Socket.IO application. It deliberately does not import Hexarch or any other game module: the visual “battle” is only a lifecycle placeholder around a server-authoritative match chat.

## Run it

Requirements: Node.js 20 or newer.

```bash
npm install
npm start
```

Open <http://127.0.0.1:4567> in two tabs. Use different display names and the same room code. The first participant is the host; once a second participant joins, the host can start and finish the placeholder match.

```bash
npm test
```

The test suite covers domain rules and a real Socket.IO server with three clients.

## Architecture

```text
Browser UI
  └─ emits commands and receives acknowledged events
       └─ Socket.IO gateway (src/server.js)
            ├─ authenticates the current connection
            ├─ uses Socket.IO rooms only for delivery
            └─ delegates decisions to ChatModule
                 ├─ session and current-socket ownership
                 ├─ match membership and phase
                 ├─ validation and idempotency
                 ├─ rate limiting
                 └─ bounded in-memory history
```

`src/chat-module.js` is the authority. A client cannot choose an author or send directly to an arbitrary room. The gateway first resolves the Player from its server-issued session token, then the module derives the Player’s current match. Only after acceptance does the gateway publish an event to the corresponding Socket.IO room.

This distinction is central to the lesson: **a Socket.IO room controls delivery, not authorization**.

## Event contract

### Session

- Client handshake auth: `{ nickname, sessionToken? }`
- Server event `session:ready`: `{ player, sessionToken, reconnectGraceMs }`

The browser keeps the token in `sessionStorage`, so each tab is a separate teaching identity while a reload can reclaim the same match for 30 seconds. A newer socket replaces an older socket holding the same token.

### Match commands

- `match:join` with `{ roomId }`
- `match:start` with `{}` (host only, at least two participants)
- `match:finish` with `{}` (host only, active battle only)
- `match:leave` with `{}`
- Server event `match:state` with the authoritative room, phase, host, participants, and presence

Every command uses a Socket.IO acknowledgement:

```json
{ "accepted": true }
```

or:

```json
{
  "accepted": false,
  "errorCode": "HOST_ONLY",
  "message": "Only the match host may do that."
}
```

### Chat command and event

Client command:

```text
chat:message:create
{
  "clientMessageId": "a-client-generated-id",
  "content": "Ready?"
}
```

Accepted server event:

```text
chat:message:created
{
  "messageId": "server-generated-id",
  "clientMessageId": "a-client-generated-id",
  "playerId": "server-owned-player-id",
  "nickname": "Alice",
  "content": "Ready?",
  "sentAt": "2026-09-11T12:00:00.000Z"
}
```

The client-generated ID makes retrying an already accepted command idempotent. The server-generated ID and timestamp identify the authoritative event.

## Rules demonstrated

- Strict payloads reject unknown fields, empty messages, and messages over 500 characters.
- The author always comes from the authenticated server session.
- A Player can chat only in their current lobby or active match.
- The waiting-room history carries into the battle.
- History is a 100-message FIFO and is lost when the process restarts.
- Each Player may send 10 messages per 10-second window.
- A finished match closes server-side chat; connected clients keep their received copy read-only.
- Reconnecting within 30 seconds restores membership and the active backlog.
- An expired lobby host closes that waiting room. During a battle, host ownership transfers to a remaining participant.
- Text is rendered with DOM `textContent`; HTML and Markdown are never interpreted.
- Browser connections must use the same origin as the teaching server, preventing another website from silently opening this Socket.IO session.

## Intentional production gaps

This is a compact teaching system, not production authentication. Session tokens and match state live only in one Node.js process. It has no database, multi-instance Socket.IO adapter, account login, moderation, reporting, mute controls, audit log, TLS termination, or distributed rate limiter. Those omissions are discussion points rather than hidden behavior.

For a production deployment, use a real authenticated identity, HTTPS, durable or deliberately expiring match state, shared adapters/rate limits across instances, moderation tools, monitoring, and a documented retention policy.
