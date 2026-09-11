export const CHAT_CONTENT_MAX_LENGTH = 500;
export const CHAT_HISTORY_LIMIT = 100;
export const CHAT_RATE_LIMIT = 10;
export const CHAT_RATE_WINDOW_MS = 10_000;
export const RECONNECT_GRACE_MS = 30_000;

const CLIENT_MESSAGE_ID = /^[A-Za-z0-9:_-]{1,80}$/;
const ROOM_ID = /^[A-Z0-9][A-Z0-9-]{2,23}$/;

export class DomainError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}

export function parseConnectionAuth(raw) {
  const auth = strictObject(raw, ['nickname', 'sessionToken'], 'INVALID_SESSION');
  const nickname = typeof auth.nickname === 'string' ? auth.nickname.trim() : '';
  if (nickname.length < 1 || nickname.length > 24 || /[\u0000-\u001f\u007f]/.test(nickname)) {
    throw new DomainError('INVALID_NICKNAME', 'Nickname must contain between 1 and 24 characters.');
  }
  if (auth.sessionToken !== undefined && (
    typeof auth.sessionToken !== 'string' || auth.sessionToken.length < 16 || auth.sessionToken.length > 100
  )) {
    throw new DomainError('INVALID_SESSION', 'The session token is invalid.');
  }
  return { nickname, sessionToken: auth.sessionToken };
}

export function parseJoinRequest(raw) {
  const request = strictObject(raw, ['roomId'], 'INVALID_ROOM');
  const roomId = typeof request.roomId === 'string' ? request.roomId.trim().toUpperCase() : '';
  if (!ROOM_ID.test(roomId)) {
    throw new DomainError('INVALID_ROOM', 'Room codes use 3 to 24 letters, numbers, or hyphens.');
  }
  return { roomId };
}

export function parseChatCommand(raw) {
  const command = strictObject(raw, ['clientMessageId', 'content'], 'INVALID_MESSAGE');
  if (typeof command.clientMessageId !== 'string' || !CLIENT_MESSAGE_ID.test(command.clientMessageId)) {
    throw new DomainError('INVALID_MESSAGE', 'The client message id is invalid.');
  }
  const content = typeof command.content === 'string' ? command.content.trim() : '';
  if (content.length < 1 || content.length > CHAT_CONTENT_MAX_LENGTH) {
    throw new DomainError(
      'INVALID_MESSAGE',
      `Messages must contain between 1 and ${CHAT_CONTENT_MAX_LENGTH} characters.`,
    );
  }
  return { clientMessageId: command.clientMessageId, content };
}

function strictObject(raw, allowedKeys, code) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new DomainError(code, 'The request payload must be an object.');
  }
  const keys = Object.keys(raw);
  if (keys.some((key) => !allowedKeys.includes(key))) {
    throw new DomainError(code, 'The request payload contains unknown fields.');
  }
  return raw;
}
