const elements = {
  joinView: document.querySelector('#join-view'),
  joinForm: document.querySelector('#join-form'),
  nickname: document.querySelector('#nickname'),
  roomId: document.querySelector('#room-id'),
  matchView: document.querySelector('#match-view'),
  matchTitle: document.querySelector('#match-title'),
  roomLabel: document.querySelector('#room-label'),
  connectionStatus: document.querySelector('#connection-status'),
  connectionLabel: document.querySelector('#connection-label'),
  gameTitle: document.querySelector('#game-title'),
  phaseDescription: document.querySelector('#phase-description'),
  arena: document.querySelector('#arena'),
  startMatch: document.querySelector('#start-match'),
  finishMatch: document.querySelector('#finish-match'),
  leaveMatch: document.querySelector('#leave-match'),
  participants: document.querySelector('#participants'),
  participantCount: document.querySelector('#participant-count'),
  chatLauncher: document.querySelector('#chat-launcher'),
  unreadCount: document.querySelector('#unread-count'),
  chatPanel: document.querySelector('#chat-panel'),
  closeChat: document.querySelector('#close-chat'),
  messages: document.querySelector('#messages'),
  emptyChat: document.querySelector('#empty-chat'),
  chatForm: document.querySelector('#chat-form'),
  messageContent: document.querySelector('#message-content'),
  chatState: document.querySelector('#chat-state'),
  notice: document.querySelector('#notice'),
};

const SESSION_KEY = 'match-chat-session-v1';
let socket = null;
let session = readStoredSession();
let pendingJoin = null;
let match = null;
let messages = [];
let panelOpen = false;
let unread = 0;
let noticeTimer = null;

if (session) {
  elements.nickname.value = session.nickname;
  if (session.roomId) {
    elements.roomId.value = session.roomId;
    pendingJoin = { roomId: session.roomId };
    createSocket(session.nickname);
    socket.connect();
  }
}

elements.joinForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const nickname = elements.nickname.value.trim();
  const roomId = elements.roomId.value.trim().toUpperCase();
  if (!nickname || !roomId) return;
  pendingJoin = { roomId };

  if (session && session.nickname !== nickname) {
    sessionStorage.removeItem(SESSION_KEY);
    session = null;
    socket?.disconnect();
    socket = null;
  }
  if (!socket) createSocket(nickname);
  if (socket.connected) joinPendingRoom();
  else socket.connect();
});

elements.startMatch.addEventListener('click', () => emitCommand('match:start', {}, (reply) => {
  if (!reply.accepted) showNotice(reply.message);
}));
elements.finishMatch.addEventListener('click', () => emitCommand('match:finish', {}, (reply) => {
  if (!reply.accepted) showNotice(reply.message);
}));
elements.leaveMatch.addEventListener('click', () => emitCommand('match:leave', {}, (reply) => {
  if (!reply.accepted) return showNotice(reply.message);
  resetMatch();
}));
elements.chatLauncher.addEventListener('click', openChat);
elements.closeChat.addEventListener('click', closeChat);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && panelOpen) closeChat();
});

elements.chatForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const content = elements.messageContent.value.trim();
  if (!content || !canWriteChat()) return;
  setChatState('Sending…');
  elements.messageContent.disabled = true;
  emitCommand('chat:message:create', {
    clientMessageId: crypto.randomUUID(),
    content,
  }, (reply) => {
    elements.messageContent.disabled = false;
    if (!reply.accepted) {
      setChatState(reply.message, true);
      elements.messageContent.focus();
      return;
    }
    elements.messageContent.value = '';
    setChatState(reply.duplicate ? 'Already delivered.' : 'Delivered.');
    elements.messageContent.focus();
  });
});

function createSocket(nickname) {
  socket = io({
    autoConnect: false,
    auth: {
      nickname,
      ...(session?.sessionToken ? { sessionToken: session.sessionToken } : {}),
    },
  });

  socket.on('connect', () => setConnection(true, 'Connected'));
  socket.on('disconnect', () => {
    setConnection(false, 'Reconnecting…');
    updateComposer();
  });
  socket.on('connect_error', (error) => {
    setConnection(false, 'Connection failed');
    showNotice(error.message || 'Unable to connect.');
  });
  socket.on('session:ready', (payload) => {
    session = {
      playerId: payload.player.playerId,
      nickname: payload.player.nickname,
      sessionToken: payload.sessionToken,
      roomId: session?.roomId ?? null,
    };
    storeSession();
    joinPendingRoom();
  });
  socket.on('match:state', (state) => {
    if (!state) return;
    match = state;
    if (session) {
      session.roomId = state.roomId;
      storeSession();
    }
    showMatch();
    renderMatch();
  });
  socket.on('match:closed', () => {
    showNotice('The host closed the waiting room.');
    resetMatch();
  });
  socket.on('chat:snapshot', (snapshot) => {
    messages = Array.isArray(snapshot?.messages) ? uniqueMessages(snapshot.messages) : [];
    unread = 0;
    renderMessages(true);
    renderUnread();
  });
  socket.on('chat:message:created', (message) => {
    if (!message || messages.some(({ messageId }) => messageId === message.messageId)) return;
    messages.push(message);
    if (messages.length > 100) messages.shift();
    if (!panelOpen && message.playerId !== session?.playerId) unread += 1;
    renderMessages(false);
    renderUnread();
  });
}

function joinPendingRoom() {
  if (!pendingJoin || !socket?.connected || !session) return;
  const requested = pendingJoin;
  pendingJoin = null;
  emitCommand('match:join', requested, (reply) => {
    if (!reply.accepted) {
      showNotice(reply.message);
      elements.joinView.hidden = false;
      elements.matchView.hidden = true;
    }
  });
}

function emitCommand(eventName, payload, acknowledge) {
  if (!socket?.connected) {
    acknowledge({ accepted: false, message: 'The real-time connection is offline.' });
    return;
  }
  socket.timeout(4_000).emit(eventName, payload, (error, reply) => {
    if (error) acknowledge({ accepted: false, message: 'The server did not acknowledge the command.' });
    else acknowledge(reply);
  });
}

function showMatch() {
  elements.joinView.hidden = true;
  elements.matchView.hidden = false;
}

function renderMatch() {
  if (!match) return;
  const isHost = match.hostPlayerId === session?.playerId;
  const phaseCopy = {
    lobby: ['Waiting room', 'Lobby', 'Invite another participant, then start the match.'],
    battle: ['Match in progress', 'Battle', 'Chat remains independent from this placeholder game state.'],
    finished: ['Match complete', 'Results', 'The server conversation is closed; received messages remain readable locally.'],
  }[match.phase];
  elements.roomLabel.textContent = match.roomId;
  elements.matchTitle.textContent = phaseCopy[0];
  elements.gameTitle.textContent = phaseCopy[1];
  elements.phaseDescription.textContent = phaseCopy[2];
  elements.arena.classList.toggle('active', match.phase === 'battle');
  elements.startMatch.hidden = match.phase !== 'lobby';
  elements.startMatch.disabled = !isHost || match.participants.length < 2;
  elements.finishMatch.hidden = match.phase !== 'battle';
  elements.finishMatch.disabled = !isHost;
  elements.leaveMatch.textContent = match.phase === 'finished' ? 'Leave results' : 'Leave';
  renderParticipants();
  updateComposer();
}

function renderParticipants() {
  elements.participants.replaceChildren();
  elements.participantCount.textContent = String(match.participants.length);
  for (const participant of match.participants) {
    const item = document.createElement('li');
    const presence = document.createElement('span');
    presence.className = `presence-dot${participant.connected ? '' : ' offline'}`;
    presence.setAttribute('aria-label', participant.connected ? 'Connected' : 'Reconnecting');
    const name = document.createElement('span');
    name.textContent = participant.playerId === session?.playerId ? `${participant.nickname} (you)` : participant.nickname;
    item.append(presence, name);
    if (participant.playerId === match.hostPlayerId) {
      const host = document.createElement('span');
      host.className = 'host-label';
      host.textContent = 'Host';
      item.append(host);
    }
    elements.participants.append(item);
  }
}

function openChat() {
  panelOpen = true;
  unread = 0;
  elements.chatPanel.hidden = false;
  elements.chatLauncher.hidden = true;
  elements.chatLauncher.setAttribute('aria-expanded', 'true');
  renderUnread();
  elements.messageContent.focus();
  elements.messages.scrollTop = elements.messages.scrollHeight;
}

function closeChat() {
  panelOpen = false;
  elements.chatPanel.hidden = true;
  elements.chatLauncher.hidden = false;
  elements.chatLauncher.setAttribute('aria-expanded', 'false');
  elements.chatLauncher.focus();
}

function renderMessages(forceBottom) {
  const nearBottom = elements.messages.scrollHeight - elements.messages.scrollTop - elements.messages.clientHeight < 60;
  elements.messages.replaceChildren();
  elements.emptyChat.hidden = messages.length > 0;
  for (const message of messages) {
    const item = document.createElement('li');
    item.className = `message${message.playerId === session?.playerId ? ' own' : ''}`;
    const meta = document.createElement('div');
    meta.className = 'message-meta';
    const author = document.createElement('strong');
    author.textContent = message.playerId === session?.playerId ? 'You' : message.nickname;
    const time = document.createElement('time');
    time.dateTime = message.sentAt;
    time.textContent = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date(message.sentAt));
    const content = document.createElement('p');
    content.textContent = message.content;
    meta.append(author, time);
    item.append(meta, content);
    elements.messages.append(item);
  }
  if (forceBottom || nearBottom) elements.messages.scrollTop = elements.messages.scrollHeight;
}

function renderUnread() {
  elements.unreadCount.hidden = unread === 0;
  elements.unreadCount.textContent = unread > 99 ? '99+' : String(unread);
  elements.chatLauncher.setAttribute('aria-label', unread ? `Open chat, ${unread} unread messages` : 'Open chat');
}

function updateComposer() {
  const writable = canWriteChat();
  elements.messageContent.disabled = !writable;
  elements.chatForm.querySelector('button').disabled = !writable;
  if (!socket?.connected) setChatState('Chat is offline. Messages remain readable.');
  else if (match?.phase === 'finished') setChatState('Chat is read-only because the match has ended.');
  else setChatState('');
}

function canWriteChat() {
  return Boolean(socket?.connected && match && match.phase !== 'finished');
}

function setConnection(online, label) {
  elements.connectionStatus.classList.toggle('online', online);
  elements.connectionLabel.textContent = label;
}

function setChatState(message, error = false) {
  elements.chatState.textContent = message;
  elements.chatState.classList.toggle('error', error);
}

function resetMatch() {
  match = null;
  messages = [];
  unread = 0;
  panelOpen = false;
  elements.matchView.hidden = true;
  elements.joinView.hidden = false;
  elements.chatPanel.hidden = true;
  elements.chatLauncher.hidden = false;
  elements.chatLauncher.setAttribute('aria-expanded', 'false');
  if (session) {
    session.roomId = null;
    storeSession();
  }
  renderMessages(true);
  renderUnread();
}

function uniqueMessages(input) {
  const seen = new Set();
  return input.filter((message) => {
    if (!message?.messageId || seen.has(message.messageId)) return false;
    seen.add(message.messageId);
    return true;
  });
}

function showNotice(message) {
  window.clearTimeout(noticeTimer);
  elements.notice.textContent = message;
  elements.notice.hidden = false;
  noticeTimer = window.setTimeout(() => {
    elements.notice.hidden = true;
  }, 5_000);
}

function readStoredSession() {
  try {
    const value = JSON.parse(sessionStorage.getItem(SESSION_KEY));
    return value && typeof value.sessionToken === 'string' && typeof value.nickname === 'string' ? value : null;
  } catch {
    return null;
  }
}

function storeSession() {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
}
