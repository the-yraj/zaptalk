require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const crypto = require('crypto');
const fetch = require('node-fetch');
const cheerio = require('cheerio');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 10e6 });

app.use(express.static(path.join(__dirname, 'public')));

// In-memory stores
const rooms = new Map();
const linkPreviewCache = new Map();

// Claude API helper
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
async function askClaude(question) {
  if (!ANTHROPIC_API_KEY) return "ZapBot is offline: missing API key ⚡";
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 500,
        system: "You are ZapBot, a helpful assistant inside ZapTalk chat. Be concise and friendly.",
        messages: [{ role: 'user', content: question }]
      })
    });
    if (!response.ok) throw new Error(`Claude API error: ${response.status}`);
    const data = await response.json();
    return data.content[0].text;
  } catch (err) {
    console.error('Claude error:', err);
    return "ZapBot is offline right now ⚡";
  }
}

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

class Room {
  constructor(roomCode, passwordHash = null, creatorUsername, settings = {}) {
    this.roomCode = roomCode;
    this.passwordHash = passwordHash;
    this.creator = creatorUsername;
    this.settings = {
      deleteTimer: settings.deleteTimer || null,
      maxUsers: settings.maxUsers || 50,
      noLogMode: settings.noLogMode || false
    };
    this.users = new Map();
    this.messages = [];
    this.messageCountToday = { date: null, count: 0 };
    this.createdAt = Date.now();
    this.timerEndTime = null;
    if (this.settings.deleteTimer) {
      const durationMs = { '1h': 3600000, '6h': 21600000, '24h': 86400000 }[this.settings.deleteTimer];
      if (durationMs) this.timerEndTime = this.createdAt + durationMs;
    }
  }

  addMessage(msg) {
    if (this.settings.noLogMode) return;
    this.messages.push(msg);
    if (this.messages.length > 100) this.messages.shift();
    const today = new Date().toDateString();
    if (this.messageCountToday.date !== today) {
      this.messageCountToday = { date: today, count: 1 };
    } else {
      this.messageCountToday.count++;
    }
  }

  getDailyMessageCount() {
    if (this.settings.noLogMode) return 0;
    const today = new Date().toDateString();
    if (this.messageCountToday.date !== today) return 0;
    return this.messageCountToday.count;
  }

  isFull() { return this.users.size >= this.settings.maxUsers; }
}

function broadcastRoomList() {
  const roomList = [];
  for (const [code, room] of rooms.entries()) {
    roomList.push({
      code,
      users: room.users.size,
      maxUsers: room.settings.maxUsers,
      hasPassword: !!room.passwordHash,
      noLogMode: room.settings.noLogMode
    });
  }
  io.emit('room_list_update', roomList);
}

function maybeDeleteRoom(roomCode) {
  const room = rooms.get(roomCode);
  if (room && room.users.size === 0) {
    rooms.delete(roomCode);
    broadcastRoomList();
  }
}

function clearRoom(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  if (!room.settings.noLogMode) {
    room.messages = [];
    room.messageCountToday = { date: null, count: 0 };
  }
  io.to(roomCode).emit('room_cleared', { timestamp: Date.now() });
}

async function fetchLinkPreview(url) {
  if (linkPreviewCache.has(url)) return linkPreviewCache.get(url);
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);
    const response = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'ZapTalkBot/1.0' } });
    clearTimeout(timeoutId);
    const html = await response.text();
    const $ = cheerio.load(html);
    const title = $('meta[property="og:title"]').attr('content') || $('title').text() || '';
    const description = $('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content') || '';
    const image = $('meta[property="og:image"]').attr('content') || '';
    const domain = new URL(url).hostname;
    const preview = { title, description, image, domain, url };
    linkPreviewCache.set(url, preview);
    return preview;
  } catch { return null; }
}

// Timer for auto-clear
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    if (room.timerEndTime && room.timerEndTime <= now) {
      clearRoom(code);
      room.timerEndTime = null;
      room.settings.deleteTimer = null;
    }
  }
}, 60000);

io.on('connection', (socket) => {
  let currentRoom = null;
  let currentUsername = null;

  socket.on('join', async ({ room, username, password, settings }) => {
    // Leave previous room if any
    if (currentRoom) {
      const oldRoom = rooms.get(currentRoom);
      if (oldRoom) {
        oldRoom.users.delete(socket.id);
        socket.leave(currentRoom);
        io.to(currentRoom).emit('user_left', { username: currentUsername, onlineCount: oldRoom.users.size });
        io.to(currentRoom).emit('online_users', Array.from(oldRoom.users.values()).map(u => u.username));
        maybeDeleteRoom(currentRoom);
      }
    }

    let roomObj = rooms.get(room);
    if (roomObj) {
      if (roomObj.passwordHash && (!password || hashPassword(password) !== roomObj.passwordHash)) {
        socket.emit('error', { message: 'Incorrect room password' });
        return;
      }
      if (roomObj.isFull()) {
        socket.emit('error', { message: `Room is full (${roomObj.users.size}/${roomObj.settings.maxUsers})` });
        return;
      }
      const existingUsers = Array.from(roomObj.users.values()).map(u => u.username);
      if (existingUsers.includes(username)) {
        socket.emit('error', { message: 'Username already taken.' });
        return;
      }
    } else {
      const passwordHash = settings?.password ? hashPassword(settings.password) : null;
      const deleteTimer = settings?.deleteTimer || null;
      const maxUsers = settings?.maxUsers || 50;
      const noLogMode = settings?.noLogMode || false;
      roomObj = new Room(room, passwordHash, username, { deleteTimer, maxUsers, noLogMode });
      rooms.set(room, roomObj);
      broadcastRoomList();
    }

    roomObj.users.set(socket.id, { username });
    socket.join(room);
    currentRoom = room;
    currentUsername = username;

    if (!roomObj.settings.noLogMode) {
      socket.emit('room_history', roomObj.messages);
    } else {
      socket.emit('room_history', []);
    }

    io.to(room).emit('user_joined', { username, onlineCount: roomObj.users.size });
    io.to(room).emit('online_users', Array.from(roomObj.users.values()).map(u => u.username));
    broadcastRoomList();

    socket.emit('room_settings', {
      maxUsers: roomObj.settings.maxUsers,
      noLogMode: roomObj.settings.noLogMode,
      deleteTimer: roomObj.settings.deleteTimer,
      timerEndTime: roomObj.timerEndTime,
      creator: roomObj.creator,
      currentUsers: roomObj.users.size
    });
  });

  socket.on('change_room', ({ room, password, username }) => {
    if (!currentRoom || !currentUsername) return;
    socket.emit('join', { room, username: username || currentUsername, password });
  });

  // Unified message handler (text, image, voice, bot command)
  socket.on('message', async ({ room, username, text, replyTo, media }) => {
    if (room !== currentRoom || username !== currentUsername) return;
    const roomObj = rooms.get(room);
    if (!roomObj) return;

    let previewData = null;
    let finalText = text || '';
    let isBotCommand = false;
    let botAnswer = null;

    if (finalText.startsWith('/ask ')) {
      isBotCommand = true;
      const question = finalText.substring(5).trim();
      if (question) botAnswer = await askClaude(question);
      else botAnswer = "Ask me something! Example: `/ask What is ZapTalk?`";
    }

    if (finalText) {
      const urlRegex = /(https?:\/\/[^\s]+)/g;
      const urls = finalText.match(urlRegex);
      if (urls && urls.length) previewData = await fetchLinkPreview(urls[0]);
    }

    const messageObj = {
      id: Date.now() + '-' + Math.random().toString(36).substr(2, 6),
      username,
      text: finalText,
      media: media || null,
      time: new Date().toISOString(),
      replyTo: replyTo || null,
      seenBy: [],
      reactions: {},
      preview: previewData
    };
    roomObj.addMessage(messageObj);
    io.to(room).emit('message', messageObj);
    socket.emit('delivery_receipt', { messageId: messageObj.id });

    if (isBotCommand && botAnswer) {
      const botMessage = {
        id: Date.now() + '-' + Math.random().toString(36).substr(2, 6),
        username: 'ZapBot',
        text: botAnswer,
        time: new Date().toISOString(),
        seenBy: [],
        reactions: {},
        isBot: true
      };
      roomObj.addMessage(botMessage);
      io.to(room).emit('message', botMessage);
    }
  });

  socket.on('messages_seen', ({ room, messageIds }) => {
    if (room !== currentRoom) return;
    const roomObj = rooms.get(room);
    if (!roomObj) return;
    for (const msgId of messageIds) {
      const msg = roomObj.messages.find(m => m.id === msgId);
      if (msg && !msg.seenBy.includes(currentUsername)) {
        msg.seenBy.push(currentUsername);
        io.to(room).emit('message_seen', { messageId: msgId, seenBy: currentUsername });
      }
    }
  });

  socket.on('react', ({ room, messageId, emoji }) => {
    if (room !== currentRoom) return;
    const roomObj = rooms.get(room);
    if (!roomObj || roomObj.settings.noLogMode) return;
    const msg = roomObj.messages.find(m => m.id === messageId);
    if (!msg) return;
    if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
    const idx = msg.reactions[emoji].indexOf(currentUsername);
    if (idx === -1) msg.reactions[emoji].push(currentUsername);
    else msg.reactions[emoji].splice(idx, 1);
    if (msg.reactions[emoji].length === 0) delete msg.reactions[emoji];
    io.to(room).emit('reaction_update', { messageId, reactions: msg.reactions });
  });

  socket.on('typing', ({ room, username }) => {
    if (room === currentRoom && username === currentUsername) {
      socket.to(room).emit('typing', { username });
    }
  });
  socket.on('stop_typing', ({ room, username }) => {
    if (room === currentRoom && username === currentUsername) {
      socket.to(room).emit('stop_typing', { username });
    }
  });

  socket.on('get_daily_count', (roomCode) => {
    const room = rooms.get(roomCode);
    if (room) socket.emit('daily_count_resp', room.getDailyMessageCount());
  });

  socket.on('ping', (callback) => {
    if (typeof callback === 'function') callback({ pong: Date.now() });
    else socket.emit('pong', Date.now());
  });

  socket.on('disconnect', () => {
    if (currentRoom && currentUsername) {
      const roomObj = rooms.get(currentRoom);
      if (roomObj) {
        roomObj.users.delete(socket.id);
        io.to(currentRoom).emit('user_left', { username: currentUsername, onlineCount: roomObj.users.size });
        io.to(currentRoom).emit('online_users', Array.from(roomObj.users.values()).map(u => u.username));
        maybeDeleteRoom(currentRoom);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`⚡ ZapTalk server running on http://localhost:${PORT}`);
});
