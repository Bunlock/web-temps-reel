import { randomUUID } from 'node:crypto';
import {
  CHAT_HISTORY_LIMIT,
  CHAT_RATE_LIMIT,
  CHAT_RATE_WINDOW_MS,
  DomainError,
  parseChatCommand,
  parseConnectionAuth,
  parseJoinRequest,
} from './contracts.js';

/**
 * Server-side authority for identity, match membership, lifecycle, and chat.
 * Socket.IO rooms are used only for delivery; this module decides who may act.
 */
export class ChatModule {
  constructor(options = {}) {
    this.now = options.now ?? (() => Date.now());
    this.newId = options.newId ?? (() => randomUUID());
    this.historyLimit = options.historyLimit ?? CHAT_HISTORY_LIMIT;
    this.rateLimit = options.rateLimit ?? CHAT_RATE_LIMIT;
    this.rateWindowMs = options.rateWindowMs ?? CHAT_RATE_WINDOW_MS;
    this.players = new Map();
    this.playerByToken = new Map();
    this.rooms = new Map();
    this.rateWindows = new Map();
  }

  connect(socketId, rawAuth) {
    const auth = parseConnectionAuth(rawAuth);
    const resumedId = auth.sessionToken ? this.playerByToken.get(auth.sessionToken) : undefined;
    const existing = resumedId ? this.players.get(resumedId) : undefined;
    if (existing) {
      const replacedSocketId = existing.socketId;
      existing.socketId = socketId;
      return { player: publicPlayer(existing), sessionToken: existing.sessionToken, replacedSocketId, roomId: existing.roomId };
    }

    const player = {
      playerId: this.newId(),
      sessionToken: this.newId(),
      nickname: auth.nickname,
      socketId,
      roomId: null,
    };
    this.players.set(player.playerId, player);
    this.playerByToken.set(player.sessionToken, player.playerId);
    return { player: publicPlayer(player), sessionToken: player.sessionToken, replacedSocketId: null, roomId: null };
  }

  disconnect(playerId, socketId) {
    const player = this.players.get(playerId);
    if (!player || player.socketId !== socketId) return null;
    player.socketId = null;
    return { playerId, roomId: player.roomId };
  }

  expireDisconnected(playerId) {
    const player = this.players.get(playerId);
    if (!player || player.socketId !== null) return null;
    const result = this.removeFromRoom(player, true);
    this.players.delete(playerId);
    this.playerByToken.delete(player.sessionToken);
    this.rateWindows.delete(playerId);
    return result;
  }

  ensureCurrentConnection(playerId, socketId) {
    const player = this.requirePlayer(playerId);
    if (player.socketId !== socketId) {
      throw new DomainError('STALE_CONNECTION', 'This connection has been replaced by a newer one.');
    }
    return player;
  }

  join(playerId, rawRequest) {
    const player = this.requirePlayer(playerId);
    const { roomId } = parseJoinRequest(rawRequest);
    if (player.roomId && player.roomId !== roomId) {
      throw new DomainError('ALREADY_IN_ROOM', 'Leave the current match before joining another one.');
    }

    let room = this.rooms.get(roomId);
    if (!room) {
      room = {
        roomId,
        hostPlayerId: playerId,
        phase: 'lobby',
        playerIds: [],
        messages: [],
        acceptedClientMessages: new Map(),
      };
      this.rooms.set(roomId, room);
    }
    if (!room.playerIds.includes(playerId)) {
      if (room.phase !== 'lobby') {
        throw new DomainError('MATCH_ALREADY_STARTED', 'This match has already started.');
      }
      if (room.playerIds.length >= 8) {
        throw new DomainError('ROOM_FULL', 'This room already has eight participants.');
      }
      room.playerIds.push(playerId);
    }
    player.roomId = roomId;
    return { state: this.roomState(roomId), snapshot: this.chatSnapshot(playerId) };
  }

  startMatch(playerId) {
    const room = this.requireRoomFor(playerId);
    this.requireHost(room, playerId);
    if (room.phase !== 'lobby') throw new DomainError('INVALID_PHASE', 'The match is not in its lobby.');
    if (room.playerIds.length < 2) throw new DomainError('NOT_ENOUGH_PLAYERS', 'At least two participants are required.');
    room.phase = 'battle';
    return this.roomState(room.roomId);
  }

  finishMatch(playerId) {
    const room = this.requireRoomFor(playerId);
    this.requireHost(room, playerId);
    if (room.phase !== 'battle') throw new DomainError('INVALID_PHASE', 'Only an active match can be completed.');
    room.phase = 'finished';
    room.messages = [];
    room.acceptedClientMessages.clear();
    return this.roomState(room.roomId);
  }

  leave(playerId) {
    const player = this.requirePlayer(playerId);
    return this.removeFromRoom(player, false);
  }

  postMessage(playerId, rawCommand) {
    const player = this.requirePlayer(playerId);
    const room = this.requireRoomFor(playerId);
    if (room.phase === 'finished') {
      throw new DomainError('CHAT_READ_ONLY', 'Chat is read-only after the match ends.');
    }
    const command = parseChatCommand(rawCommand);
    const duplicate = room.acceptedClientMessages.get(command.clientMessageId);
    if (duplicate) return { message: duplicate, duplicate: true, roomId: room.roomId };

    this.consumeRateLimit(playerId);
    const message = {
      messageId: this.newId(),
      clientMessageId: command.clientMessageId,
      playerId,
      nickname: player.nickname,
      content: command.content,
      sentAt: new Date(this.now()).toISOString(),
    };
    room.messages.push(message);
    room.acceptedClientMessages.set(command.clientMessageId, message);
    while (room.messages.length > this.historyLimit) {
      const removed = room.messages.shift();
      if (removed) room.acceptedClientMessages.delete(removed.clientMessageId);
    }
    return { message, duplicate: false, roomId: room.roomId };
  }

  chatSnapshot(playerId) {
    const room = this.requireRoomFor(playerId);
    return { messages: room.messages.map((message) => ({ ...message })) };
  }

  roomState(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    return {
      roomId: room.roomId,
      hostPlayerId: room.hostPlayerId,
      phase: room.phase,
      participants: room.playerIds.map((playerId) => {
        const player = this.requirePlayer(playerId);
        return { ...publicPlayer(player), connected: player.socketId !== null };
      }),
    };
  }

  roomSocketIds(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    return room.playerIds
      .map((playerId) => this.players.get(playerId)?.socketId)
      .filter((socketId) => typeof socketId === 'string');
  }

  sessionRoomId(playerId) {
    return this.players.get(playerId)?.roomId ?? null;
  }

  removeFromRoom(player, expired) {
    const roomId = player.roomId;
    if (!roomId) return { roomId: null, closed: false, affectedSocketIds: [] };
    const room = this.rooms.get(roomId);
    player.roomId = null;
    if (!room) return { roomId, closed: false, affectedSocketIds: [] };

    const affectedSocketIds = this.roomSocketIds(roomId).filter((socketId) => socketId !== player.socketId);
    room.playerIds = room.playerIds.filter((id) => id !== player.playerId);
    const closeLobby = room.phase === 'lobby' && room.hostPlayerId === player.playerId;
    if (closeLobby || room.playerIds.length === 0) {
      for (const memberId of room.playerIds) {
        const member = this.players.get(memberId);
        if (member) member.roomId = null;
      }
      this.rooms.delete(roomId);
      return { roomId, closed: true, affectedSocketIds };
    }
    if (room.hostPlayerId === player.playerId) room.hostPlayerId = room.playerIds[0];
    return { roomId, closed: false, affectedSocketIds, state: this.roomState(roomId), expired };
  }

  consumeRateLimit(playerId) {
    const now = this.now();
    const recent = (this.rateWindows.get(playerId) ?? []).filter((timestamp) => timestamp > now - this.rateWindowMs);
    if (recent.length >= this.rateLimit) {
      throw new DomainError('CHAT_RATE_LIMITED', 'Too many messages. Please wait a moment.');
    }
    recent.push(now);
    this.rateWindows.set(playerId, recent);
  }

  requirePlayer(playerId) {
    const player = this.players.get(playerId);
    if (!player) throw new DomainError('SESSION_NOT_FOUND', 'The session is no longer available.');
    return player;
  }

  requireRoomFor(playerId) {
    const player = this.requirePlayer(playerId);
    const room = player.roomId ? this.rooms.get(player.roomId) : undefined;
    if (!room || !room.playerIds.includes(playerId)) {
      throw new DomainError('CHAT_NOT_AVAILABLE', 'Join a match before using chat.');
    }
    return room;
  }

  requireHost(room, playerId) {
    if (room.hostPlayerId !== playerId) throw new DomainError('HOST_ONLY', 'Only the match host may do that.');
  }
}

function publicPlayer(player) {
  return { playerId: player.playerId, nickname: player.nickname };
}
