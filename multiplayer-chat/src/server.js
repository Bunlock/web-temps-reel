import { createServer as createHttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { ChatModule } from './chat-module.js';
import { DomainError, RECONNECT_GRACE_MS } from './contracts.js';

const PUBLIC_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PUBLIC_FILES = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/app.js', 'app.js'],
  ['/styles.css', 'styles.css'],
]);

export function createChatServer(options = {}) {
  const chat = options.chat ?? new ChatModule();
  const reconnectGraceMs = options.reconnectGraceMs ?? RECONNECT_GRACE_MS;
  const httpServer = createHttpServer((request, response) => serve(request, response));
  const io = new Server(httpServer, {
    serveClient: true,
    maxHttpBufferSize: 16 * 1024,
    allowRequest: sameOriginRequest,
  });

  io.use((socket, next) => {
    try {
      socket.data.session = chat.connect(socket.id, socket.handshake.auth);
      next();
    } catch (error) {
      const failure = asFailure(error);
      const connectionError = new Error(failure.message);
      connectionError.data = { code: failure.errorCode };
      next(connectionError);
    }
  });

  io.on('connection', (socket) => {
    const session = socket.data.session;
    const playerId = session.player.playerId;
    if (session.replacedSocketId && session.replacedSocketId !== socket.id) {
      io.sockets.sockets.get(session.replacedSocketId)?.disconnect(true);
    }
    socket.emit('session:ready', {
      player: session.player,
      sessionToken: session.sessionToken,
      reconnectGraceMs,
    });

    const restoredRoomId = session.roomId;
    if (restoredRoomId) {
      void socket.join(deliveryRoom(restoredRoomId));
      socket.emit('match:state', chat.roomState(restoredRoomId));
      socket.emit('chat:snapshot', chat.chatSnapshot(playerId));
      emitRoomState(restoredRoomId);
    }

    socket.on('match:join', (request, acknowledge) => respond(acknowledge, () => {
      assertCurrent();
      const result = chat.join(playerId, request);
      void socket.join(deliveryRoom(result.state.roomId));
      socket.emit('chat:snapshot', result.snapshot);
      emitRoomState(result.state.roomId);
      return { roomId: result.state.roomId };
    }));

    socket.on('match:start', (_request, acknowledge) => respond(acknowledge, () => {
      assertCurrent();
      const state = chat.startMatch(playerId);
      io.to(deliveryRoom(state.roomId)).emit('match:state', state);
      return { phase: state.phase };
    }));

    socket.on('match:finish', (_request, acknowledge) => respond(acknowledge, () => {
      assertCurrent();
      const state = chat.finishMatch(playerId);
      io.to(deliveryRoom(state.roomId)).emit('match:state', state);
      return { phase: state.phase };
    }));

    socket.on('match:leave', (_request, acknowledge) => respond(acknowledge, () => {
      assertCurrent();
      const result = chat.leave(playerId);
      if (result.roomId) void socket.leave(deliveryRoom(result.roomId));
      publishRemoval(result);
      return {};
    }));

    socket.on('chat:message:create', (command, acknowledge) => respond(acknowledge, () => {
      assertCurrent();
      const result = chat.postMessage(playerId, command);
      if (!result.duplicate) {
        io.to(deliveryRoom(result.roomId)).emit('chat:message:created', result.message);
      }
      return { messageId: result.message.messageId, duplicate: result.duplicate };
    }));

    socket.on('disconnect', () => {
      const disconnected = chat.disconnect(playerId, socket.id);
      if (!disconnected) return;
      if (disconnected.roomId) emitRoomState(disconnected.roomId);
      setTimeout(() => {
        const result = chat.expireDisconnected(playerId);
        if (result) publishRemoval(result);
      }, reconnectGraceMs).unref?.();
    });

    function assertCurrent() {
      chat.ensureCurrentConnection(playerId, socket.id);
    }
  });

  function emitRoomState(roomId) {
    const state = chat.roomState(roomId);
    if (state) io.to(deliveryRoom(roomId)).emit('match:state', state);
  }

  function publishRemoval(result) {
    if (!result.roomId) return;
    if (result.closed) {
      for (const socketId of result.affectedSocketIds) {
        const affected = io.sockets.sockets.get(socketId);
        affected?.emit('match:closed', { roomId: result.roomId });
        void affected?.leave(deliveryRoom(result.roomId));
      }
      return;
    }
    if (result.state) io.to(deliveryRoom(result.roomId)).emit('match:state', result.state);
  }

  return {
    chat,
    httpServer,
    io,
    async listen(port = 0, host = '127.0.0.1') {
      await new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(port, host, () => {
          httpServer.off('error', reject);
          resolve();
        });
      });
      return httpServer.address();
    },
    async close() {
      await new Promise((resolve) => io.close(() => resolve()));
      if (httpServer.listening) await new Promise((resolve) => httpServer.close(() => resolve()));
    },
  };
}

function respond(acknowledge, operation) {
  const reply = typeof acknowledge === 'function' ? acknowledge : () => undefined;
  try {
    reply({ accepted: true, ...operation() });
  } catch (error) {
    reply({ accepted: false, ...asFailure(error) });
  }
}

function asFailure(error) {
  if (error instanceof DomainError) return { errorCode: error.code, message: error.message };
  console.error(error);
  return { errorCode: 'INTERNAL_ERROR', message: 'The server could not process the request.' };
}

function deliveryRoom(roomId) {
  return `match:${roomId}`;
}

function sameOriginRequest(request, callback) {
  const origin = request.headers.origin;
  const allowed = sameOriginAllowed(origin, request.headers.host);
  callback(allowed ? null : new Error('Origin not allowed'), allowed);
}

export function sameOriginAllowed(origin, host) {
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return ['http:', 'https:'].includes(parsed.protocol) && parsed.host === host;
  } catch {
    return false;
  }
}

async function serve(request, response) {
  if (request.method === 'GET' && request.url === '/healthz') {
    response.writeHead(200, securityHeaders({ 'content-type': 'application/json; charset=utf-8' }));
    response.end('{"status":"ok"}');
    return;
  }
  const file = request.method === 'GET' ? PUBLIC_FILES.get(request.url) : undefined;
  if (!file) {
    response.writeHead(404, securityHeaders({ 'content-type': 'text/plain; charset=utf-8' }));
    response.end('Not found');
    return;
  }
  try {
    const body = await readFile(join(PUBLIC_DIRECTORY, file));
    response.writeHead(200, securityHeaders({ 'content-type': contentType(file) }));
    response.end(body);
  } catch {
    response.writeHead(500, securityHeaders({ 'content-type': 'text/plain; charset=utf-8' }));
    response.end('Unable to load the application');
  }
}

function securityHeaders(extra) {
  return {
    'content-security-policy': "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self'; script-src 'self'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...extra,
  };
}

function contentType(file) {
  return ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' })[extname(file)]
    ?? 'application/octet-stream';
}
