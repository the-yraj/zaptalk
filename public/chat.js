// ==================== ZAPTALK FULL CLIENT ====================
(function() {
  // -------------------- DOM Elements --------------------
  const elements = {
    messagesDiv: document.getElementById('messagesArea'),
    messageInput: document.getElementById('messageInput'),
    sendBtn: document.getElementById('sendBtn'),
    roomBadge: document.getElementById('roomCodeBadge'),
    onlineBadge: document.getElementById('onlineBadge'),
    leftPanel: document.getElementById('leftPanel'),
    rightPanel: document.getElementById('rightPanel'),
    leftOverlay: document.getElementById('leftPanelOverlay'),
    rightOverlay: document.getElementById('rightPanelOverlay'),
    toggleLeft: document.getElementById('toggleLeftBtn'),
    toggleRight: document.getElementById('toggleRightBtn'),
    closeLeft: document.getElementById('closeLeftPanel'),
    closeRight: document.getElementById('closeRightPanel'),
    roomsList: document.getElementById('roomsList'),
    membersList: document.getElementById('membersList'),
    quickRoomCode: document.getElementById('quickRoomCode'),
    quickPassword: document.getElementById('quickPassword'),
    quickJoinBtn: document.getElementById('quickJoinBtn'),
    statsToday: document.getElementById('statsToday'),
    statsTimer: document.getElementById('statsTimer'),
    statsCapacity: document.getElementById('statsCapacity'),
    statsPing: document.getElementById('statsPing'),
    themeToggle: document.getElementById('themeToggleBtn'),
    soundToggle: document.getElementById('soundToggleBtn'),
    replyPreview: document.getElementById('replyPreview'),
    replyToUser: document.getElementById('replyToUser'),
    replyToText: document.getElementById('replyToText'),
    cancelReply: document.getElementById('cancelReplyBtn'),
    typingIndicator: document.getElementById('globalTypingIndicator'),
    attachBtn: document.getElementById('attachBtn'),
    voiceBtn: document.getElementById('voiceBtn'),
    recordingIndicator: document.getElementById('recordingIndicator'),
    lightbox: document.getElementById('lightbox'),
    lightboxImg: document.getElementById('lightbox-img'),
    searchToggle: document.getElementById('searchToggleBtn'),
    searchBar: document.getElementById('searchBar'),
    searchInput: document.getElementById('searchInput'),
    searchCount: document.getElementById('searchResultsCount'),
    closeSearch: document.getElementById('closeSearchBtn'),
    scrollBtn: document.getElementById('scrollToBottomBtn'),
    reconnectBanner: document.getElementById('reconnectBanner'),
    noLogBadgeRight: document.getElementById('noLogBadge'),
    noLogHeaderBadge: document.getElementById('noLogHeaderBadge'),
    emojiPicker: document.getElementById('emojiPicker'),
    emojiBtn: document.getElementById('emojiBtn')
  };

  // -------------------- State --------------------
  const urlParams = new URLSearchParams(window.location.search);
  const roomCode = urlParams.get('room');
  const username = urlParams.get('user');
  const storedPassword = sessionStorage.getItem('zaptalk_password') || '';
  sessionStorage.removeItem('zaptalk_password');
  const storedSettings = JSON.parse(sessionStorage.getItem('zaptalk_settings') || '{}');

  let socket = io({ reconnection: true, reconnectionAttempts: Infinity, reconnectionDelay: 3000 });
  let currentRoom = roomCode;
  let currentUsername = username;
  let typingTimeout = null;
  let activeReply = null;
  let messageElements = new Map();
  let seenMessageIds = new Set();
  let soundEnabled = localStorage.getItem('zaptalk_sound') !== 'false';
  let roomSettings = { maxUsers: 0, noLogMode: false, deleteTimer: null, timerEndTime: null, creator: '', currentUsers: 0 };
  let timerInterval = null;
  let typingUsers = new Set();
  let typingTimer = null;
  let originalMessagesHTML = '';
  let notificationPermission = false;
  let audioCtx = null;

  // Media recording
  let mediaRecorder = null;
  let audioChunks = [];
  let recordingStartTime = null;
  let recordingTimer = null;

  // -------------------- Helper Functions --------------------
  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>]/g, m => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;' }[m]));
  }
  function escapeRegex(str) { return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function scrollToBottom() { elements.messagesDiv.scrollTop = elements.messagesDiv.scrollHeight; }
  function isUserAtBottom() {
    const { scrollTop, scrollHeight, clientHeight } = elements.messagesDiv;
    return scrollHeight - scrollTop - clientHeight < 50;
  }
  function updateScrollButton() {
    if (isUserAtBottom()) elements.scrollBtn.classList.add('hidden');
    else elements.scrollBtn.classList.remove('hidden');
  }
  function formatDuration(sec) {
    const mins = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${mins}:${s.toString().padStart(2,'0')}`;
  }

  // Avatar cache
  const avatarCache = new Map();
  function getAvatarUrl(uname) {
    if (avatarCache.has(uname)) return avatarCache.get(uname);
    const url = `https://api.dicebear.com/7.x/thumbs/svg?seed=${encodeURIComponent(uname)}&backgroundColor=0d1520&radius=50`;
    avatarCache.set(uname, url);
    return url;
  }

  // Smart timestamps
  function formatMessageTime(isoString) {
    const date = new Date(isoString);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const msgDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    let dayStr = '';
    if (msgDate.getTime() === today.getTime()) dayStr = '';
    else if (msgDate.getTime() === yesterday.getTime()) dayStr = 'Yesterday ';
    else dayStr = date.toLocaleDateString(undefined, { weekday: 'short' }) + ' ';
    return dayStr + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  function getFullDateTooltip(isoString) { return new Date(isoString).toLocaleString(); }

  // Sound notification
  function playNotificationSound(louder = false) {
    if (!soundEnabled) return;
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const ctx = audioCtx;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = louder ? 1200 : 880;
    gain.gain.setValueAtTime(0.15, now);
    gain.gain.exponentialRampToValueAtTime(0.00001, now + (louder ? 0.4 : 0.3));
    osc.start();
    osc.stop(now + (louder ? 0.25 : 0.2));
  }

  // Mention detection
  function checkMentions(text, msgUsername, msgRoom) {
    if (!text) return;
    const mentionRegex = new RegExp(`@${escapeRegex(currentUsername)}`, 'i');
    if (mentionRegex.test(text) && msgUsername !== currentUsername) {
      if (notificationPermission && document.visibilityState !== 'visible') {
        new Notification(`ZapTalk: ${msgUsername} mentioned you`, {
          body: `In room #${msgRoom}: "${text.substring(0, 60)}"`,
          icon: '/icon-192.png'
        });
      }
      playNotificationSound(true);
    }
  }

  // Audio player initialization
  function initAudioPlayer(container) {
    const audioData = container.getAttribute('data-audio');
    const audio = new Audio(audioData);
    const playBtn = container.querySelector('.play-pause');
    const durationDiv = container.querySelector('.audio-duration');
    const progressBar = container.querySelector('.audio-progress-bar');
    const canvas = container.querySelector('.waveform-canvas');
    if (canvas) {
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#00fff9';
      for (let i = 0; i < 20; i++) {
        const height = Math.random() * 15 + 5;
        ctx.fillRect(i * 6, 30 - height, 3, height);
      }
    }
    let isPlaying = false;
    playBtn.addEventListener('click', () => {
      if (isPlaying) {
        audio.pause();
        playBtn.textContent = '▶';
      } else {
        audio.play();
        playBtn.textContent = '⏸';
      }
      isPlaying = !isPlaying;
    });
    audio.addEventListener('timeupdate', () => {
      const percent = (audio.currentTime / audio.duration) * 100;
      if (progressBar) progressBar.style.width = percent + '%';
      if (durationDiv) durationDiv.textContent = `${formatDuration(audio.currentTime)} / ${formatDuration(audio.duration)}`;
    });
    audio.addEventListener('ended', () => {
      playBtn.textContent = '▶';
      isPlaying = false;
      if (progressBar) progressBar.style.width = '0%';
    });
  }

  // Floating reaction bar
  let floatingBar = null;
  function showFloatingReactionBar(msgDiv, msgId) {
    if (floatingBar) floatingBar.remove();
    floatingBar = document.createElement('div');
    floatingBar.className = 'floating-emoji-bar';
    floatingBar.innerHTML = `👍 ❤️ 😂 😮 😢 🔥`.split(' ').map(e => `<span>${e}</span>`).join('');
    floatingBar.querySelectorAll('span').forEach(span => {
      span.addEventListener('click', (e) => {
        e.stopPropagation();
        socket.emit('react', { room: currentRoom, messageId: msgId, emoji: span.innerText });
        floatingBar.remove();
      });
    });
    msgDiv.querySelector('.message-bubble').appendChild(floatingBar);
    setTimeout(() => { if (floatingBar) floatingBar.remove(); }, 3000);
  }

  function markMessageSeen(msgId) {
    if (seenMessageIds.has(msgId)) return;
    seenMessageIds.add(msgId);
    socket.emit('messages_seen', { room: currentRoom, messageIds: [msgId] });
  }

  function updateReactions(msgId, reactions) {
    const msgDiv = messageElements.get(msgId);
    if (!msgDiv) return;
    let reactionsDiv = msgDiv.querySelector('.message-reactions');
    if (!reactionsDiv && Object.keys(reactions).length) {
      reactionsDiv = document.createElement('div');
      reactionsDiv.className = 'message-reactions';
      msgDiv.querySelector('.message-bubble').appendChild(reactionsDiv);
    }
    if (reactionsDiv) {
      reactionsDiv.innerHTML = Object.entries(reactions).map(([emoji, users]) =>
        `<span class="reaction-pill" data-emoji="${emoji}" data-msg-id="${msgId}">${emoji} ${users.length}</span>`
      ).join('');
      reactionsDiv.querySelectorAll('.reaction-pill').forEach(pill => {
        pill.addEventListener('click', (e) => {
          e.stopPropagation();
          socket.emit('react', { room: currentRoom, messageId: msgId, emoji: pill.getAttribute('data-emoji') });
        });
      });
    }
  }

  function updateReadReceipt(msgId) {
    const msgDiv = messageElements.get(msgId);
    if (msgDiv && msgDiv.classList.contains('own-message')) {
      let receipt = msgDiv.querySelector('.read-receipt');
      if (receipt) receipt.innerHTML = '✓✓';
      else msgDiv.querySelector('.message-bubble').insertAdjacentHTML('beforeend', '<div class="read-receipt">✓✓</div>');
    }
  }

  function addSystemMessage(text) {
    const div = document.createElement('div');
    div.className = 'system-message';
    div.innerText = text;
    elements.messagesDiv.appendChild(div);
    scrollToBottom();
  }

  function updateTypingIndicator() {
    if (typingUsers.size === 0) {
      elements.typingIndicator.style.display = 'none';
      elements.typingIndicator.innerHTML = '';
      return;
    }
    elements.typingIndicator.style.display = 'block';
    const names = Array.from(typingUsers);
    let text = '';
    if (names.length === 1) text = `${names[0]} is typing...`;
    else if (names.length === 2) text = `${names[0]} and ${names[1]} are typing...`;
    else text = `${names[0]}, ${names[1]} and ${names.length-2} others are typing...`;
    elements.typingIndicator.innerHTML = `<span class="typing-dots">⏵ ${text}</span>`;
  }

  function updateCapacityDisplay() {
    elements.statsCapacity.innerText = `${roomSettings.currentUsers || 0}/${roomSettings.maxUsers || 0}`;
  }

  function startTimerCountdown(endTime) {
    if (timerInterval) clearInterval(timerInterval);
    const update = () => {
      const remain = endTime - Date.now();
      if (remain <= 0) {
        elements.statsTimer.innerText = 'Cleared';
        clearInterval(timerInterval);
        return;
      }
      const h = Math.floor(remain / 3600000);
      const m = Math.floor((remain % 3600000) / 60000);
      elements.statsTimer.innerText = `${h}h ${m}m`;
    };
    update();
    timerInterval = setInterval(update, 60000);
  }

  // -------------------- Rendering Messages (with grouping) --------------------
  let lastRenderedMsg = null;
  function shouldGroup(prev, curr) {
    return prev && prev.username === curr.username && (new Date(curr.time) - new Date(prev.time) <= 60000);
  }

  function renderMessage(msg, isOwn = false, isGrouped = false) {
    const div = document.createElement('div');
    div.className = `message ${isOwn ? 'own-message' : ''} ${isGrouped ? 'message-grouped' : ''} ${msg.isBot ? 'message-bot' : ''}`;
    div.setAttribute('data-msg-id', msg.id);
    div.setAttribute('data-time-iso', msg.time);

    // Avatar
    let avatarHtml = '';
    if (msg.isBot) {
      avatarHtml = `<div class="avatar-fallback" style="background:#ffee00; color:black;">⚡</div>`;
    } else {
      const avatarUrl = getAvatarUrl(msg.username);
      avatarHtml = `<img src="${avatarUrl}" class="avatar-img" onerror="this.onerror=null; this.parentElement.innerHTML='<div class=\'avatar-fallback\'>${msg.username.slice(0,2).toUpperCase()}</div>'">`;
    }

    let headerHtml = '';
    if (!isGrouped) {
      const timeLabel = formatMessageTime(msg.time);
      headerHtml = `<div class="message-header">
        <span class="username">${escapeHtml(msg.username)}</span>
        ${msg.isBot ? '<span class="bot-badge">[BOT]</span>' : ''}
        <span class="time" title="${getFullDateTooltip(msg.time)}">${timeLabel}</span>
      </div>`;
    }

    let displayText = escapeHtml(msg.text || '');
    if (!isOwn && currentUsername) {
      const regex = new RegExp(`(@${escapeRegex(currentUsername)})`, 'gi');
      displayText = displayText.replace(regex, '<span class="mention-highlight">$1</span>');
    }

    // Reply block
    let replyHtml = '';
    if (msg.replyTo && msg.replyTo.text) {
      replyHtml = `<div class="reply-quote-block">↩ <strong>${escapeHtml(msg.replyTo.user)}</strong>: ${escapeHtml(msg.replyTo.text.substring(0,60))}</div>`;
    }

    // Media
    let mediaHtml = '';
    if (msg.media) {
      if (msg.media.type === 'image') {
        mediaHtml = `<img src="${msg.media.data}" class="message-image" loading="lazy"><div class="image-meta">📷 ${escapeHtml(msg.media.filename)} (${(msg.media.size/1024).toFixed(1)} KB)</div>`;
      } else if (msg.media.type === 'audio') {
        mediaHtml = `<div class="audio-player" data-audio="${msg.media.data}"><button class="play-pause">▶</button><canvas class="waveform-canvas" width="120" height="30"></canvas><div class="audio-duration">0:00 / ${formatDuration(msg.media.duration)}</div><div class="audio-progress"><div class="audio-progress-bar"></div></div></div>`;
      }
    }

    // Link preview
    let previewHtml = '';
    if (msg.preview) {
      previewHtml = `<div class="link-preview">
        ${msg.preview.image ? `<img src="${escapeHtml(msg.preview.image)}" class="link-preview-image" onerror="this.style.display='none'">` : ''}
        <div class="link-preview-content">
          <div class="link-preview-title">${escapeHtml(msg.preview.title)}</div>
          <div class="link-preview-description">${escapeHtml(msg.preview.description?.substring(0,100) || '')}</div>
          <div class="link-preview-domain">${escapeHtml(msg.preview.domain)}</div>
        </div>
      </div>`;
    }

    // Reactions
    let reactionsHtml = '';
    if (msg.reactions && Object.keys(msg.reactions).length) {
      reactionsHtml = `<div class="message-reactions">` +
        Object.entries(msg.reactions).map(([emoji, users]) =>
          `<span class="reaction-pill" data-emoji="${emoji}" data-msg-id="${msg.id}">${emoji} ${users.length}</span>`
        ).join('') + `</div>`;
    }

    // Receipt
    let receiptHtml = '';
    if (isOwn) {
      const isSeen = msg.seenBy && msg.seenBy.length > 0;
      receiptHtml = `<div class="read-receipt">${isSeen ? '✓✓' : '✓'}</div>`;
    }

    div.innerHTML = `${avatarHtml}<div class="message-bubble">${headerHtml}${replyHtml}<div class="message-text">${displayText}</div>${mediaHtml}${previewHtml}${reactionsHtml}${receiptHtml}</div>`;

    // Image click lightbox
    const img = div.querySelector('.message-image');
    if (img) img.addEventListener('click', () => { elements.lightboxImg.src = img.src; elements.lightbox.classList.remove('hidden'); });

    // Audio player
    const audioPlayer = div.querySelector('.audio-player');
    if (audioPlayer) initAudioPlayer(audioPlayer);

    // Reaction pills
    div.querySelectorAll('.reaction-pill').forEach(pill => {
      pill.addEventListener('click', (e) => {
        e.stopPropagation();
        socket.emit('react', { room: currentRoom, messageId: msg.id, emoji: pill.getAttribute('data-emoji') });
      });
    });
    div.addEventListener('mouseenter', () => showFloatingReactionBar(div, msg.id));

    elements.messagesDiv.appendChild(div);
    messageElements.set(msg.id, div);

    // Empty state
    const emptyDiv = elements.messagesDiv.querySelector('.empty-state');
    if (emptyDiv && messageElements.size === 0) emptyDiv.classList.remove('hidden');
    else if (emptyDiv) emptyDiv.classList.add('hidden');

    if (isUserAtBottom()) scrollToBottom();
    updateScrollButton();
    if (!isOwn && document.hasFocus()) markMessageSeen(msg.id);
  }

  // -------------------- Search Feature --------------------
  function searchMessages(query) {
    if (!query.trim()) {
      if (originalMessagesHTML) elements.messagesDiv.innerHTML = originalMessagesHTML;
      else elements.messagesDiv.querySelectorAll('.message').forEach(msg => msg.style.display = '');
      elements.searchCount.innerText = '0 results';
      return;
    }
    if (!originalMessagesHTML) originalMessagesHTML = elements.messagesDiv.innerHTML;
    const regex = new RegExp(`(${escapeRegex(query)})`, 'gi');
    let matchCount = 0;
    elements.messagesDiv.querySelectorAll('.message').forEach(msgDiv => {
      const textEl = msgDiv.querySelector('.message-text');
      if (!textEl) return;
      const originalText = textEl.innerText;
      if (originalText.toLowerCase().includes(query.toLowerCase())) {
        msgDiv.style.display = '';
        const highlighted = originalText.replace(regex, '<mark class="search-highlight">$1</mark>');
        textEl.innerHTML = highlighted;
        matchCount++;
      } else {
        msgDiv.style.display = 'none';
      }
    });
    elements.searchCount.innerText = `${matchCount} result${matchCount !== 1 ? 's' : ''}`;
  }

  // -------------------- Voice Recording --------------------
  let mediaStream = null;
  async function startRecording() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert('Recording not supported');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStream = stream;
      mediaRecorder = new MediaRecorder(stream);
      audioChunks = [];
      mediaRecorder.ondataavailable = event => audioChunks.push(event.data);
      mediaRecorder.start();
      recordingStartTime = Date.now();
      elements.recordingIndicator.classList.remove('hidden');
      let elapsed = 0;
      recordingTimer = setInterval(() => {
        elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
        if (elapsed >= 60) stopRecording();
        elements.recordingIndicator.innerText = `🎙️ Recording... ${Math.floor(elapsed/60)}:${(elapsed%60).toString().padStart(2,'0')}`;
      }, 1000);
    } catch (err) {
      console.error(err);
      alert('Microphone access denied');
    }
  }
  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
      clearInterval(recordingTimer);
      elements.recordingIndicator.classList.add('hidden');
      mediaRecorder.onstop = async () => {
        const blob = new Blob(audioChunks, { type: 'audio/webm' });
        const duration = (Date.now() - recordingStartTime) / 1000;
        if (duration < 0.5) return;
        const reader = new FileReader();
        reader.readAsDataURL(blob);
        reader.onloadend = () => {
          socket.emit('message', {
            room: currentRoom,
            username: currentUsername,
            text: '',
            replyTo: activeReply,
            media: { type: 'audio', data: reader.result, duration, size: blob.size }
          });
          activeReply = null;
          elements.replyPreview.classList.add('hidden');
        };
      };
      if (mediaStream) mediaStream.getTracks().forEach(track => track.stop());
      mediaStream = null;
    }
  }

  // -------------------- Socket Events --------------------
  socket.on('connect', () => {
    elements.reconnectBanner.classList.add('hidden');
    socket.emit('join', { room: currentRoom, username: currentUsername, password: storedPassword, settings: storedSettings });
  });
  socket.on('disconnect', () => elements.reconnectBanner.classList.remove('hidden'));
  socket.on('connect_error', () => elements.reconnectBanner.classList.remove('hidden'));

  socket.on('room_history', (messages) => {
    elements.messagesDiv.innerHTML = '<div class="empty-state">⚡ Start the conversation</div>';
    messageElements.clear();
    let prev = null;
    messages.forEach(msg => {
      const isOwn = msg.username === currentUsername;
      const grouped = shouldGroup(prev, msg);
      renderMessage(msg, isOwn, grouped);
      prev = msg;
    });
    if (isUserAtBottom()) scrollToBottom();
  });

  socket.on('message', (msg) => {
    const lastMsgElem = elements.messagesDiv.lastChild;
    let prev = null;
    if (lastMsgElem && lastMsgElem.getAttribute('data-msg-id')) {
      const lastId = lastMsgElem.getAttribute('data-msg-id');
      const prevDiv = messageElements.get(lastId);
      if (prevDiv) prev = { username: prevDiv.querySelector('.username')?.innerText, time: lastMsgElem.getAttribute('data-time-iso') };
    }
    const isOwn = msg.username === currentUsername;
    const grouped = shouldGroup(prev, msg);
    renderMessage(msg, isOwn, grouped);
    if (!isOwn) {
      checkMentions(msg.text, msg.username, currentRoom);
      if (!document.hasFocus()) playNotificationSound(false);
      if (document.hasFocus()) markMessageSeen(msg.id);
    }
  });

  socket.on('user_joined', ({ username: usr, onlineCount }) => {
    addSystemMessage(`${usr} joined`);
    elements.onlineBadge.innerHTML = `⬤ ${onlineCount}`;
    roomSettings.currentUsers = onlineCount;
    updateCapacityDisplay();
  });
  socket.on('user_left', ({ username: usr, onlineCount }) => {
    addSystemMessage(`${usr} left`);
    elements.onlineBadge.innerHTML = `⬤ ${onlineCount}`;
    roomSettings.currentUsers = onlineCount;
    updateCapacityDisplay();
  });
  socket.on('online_users', (usersList) => {
    elements.onlineBadge.innerHTML = `⬤ ${usersList.length}`;
    elements.membersList.innerHTML = usersList.map(u => `<div class="member-item"><span>👤 ${escapeHtml(u)}</span><span class="online-dot">●</span></div>`).join('');
  });
  socket.on('room_list_update', (rooms) => {
    elements.roomsList.innerHTML = rooms.map(r => `<div class="room-item" data-room="${r.code}"><span>${r.code}</span><span>👥 ${r.users}/${r.maxUsers}</span></div>`).join('');
    document.querySelectorAll('.room-item').forEach(el => {
      el.addEventListener('click', () => {
        const rcode = el.getAttribute('data-room');
        const roomData = rooms.find(r => r.code === rcode);
        let pwd = null;
        if (roomData?.hasPassword) pwd = prompt('Enter password:');
        socket.emit('change_room', { room: rcode, password: pwd, username: currentUsername });
      });
    });
  });
  socket.on('room_settings', (settings) => {
    roomSettings = settings;
    if (roomSettings.noLogMode) {
      elements.noLogBadgeRight.classList.remove('hidden');
      elements.noLogHeaderBadge.classList.remove('hidden');
    } else {
      elements.noLogBadgeRight.classList.add('hidden');
      elements.noLogHeaderBadge.classList.add('hidden');
    }
    updateCapacityDisplay();
    if (roomSettings.timerEndTime) startTimerCountdown(roomSettings.timerEndTime);
    else elements.statsTimer.innerText = 'None';
  });
  socket.on('room_cleared', () => {
    addSystemMessage('⚡ Room auto-cleared by timer');
    elements.messagesDiv.innerHTML = '<div class="empty-state">⚡ Start the conversation</div>';
    messageElements.clear();
  });
  socket.on('message_seen', ({ messageId }) => updateReadReceipt(messageId));
  socket.on('reaction_update', ({ messageId, reactions }) => updateReactions(messageId, reactions));
  socket.on('delivery_receipt', ({ messageId }) => {
    const msgDiv = messageElements.get(messageId);
    if (msgDiv && msgDiv.classList.contains('own-message')) {
      let receipt = msgDiv.querySelector('.read-receipt');
      if (receipt) receipt.innerHTML = '✓';
      else msgDiv.querySelector('.message-bubble').insertAdjacentHTML('beforeend', '<div class="read-receipt">✓</div>');
    }
  });
  socket.on('typing', ({ username: u }) => {
    if (u !== currentUsername) {
      typingUsers.add(u);
      updateTypingIndicator();
      clearTimeout(typingTimer);
      typingTimer = setTimeout(() => { typingUsers.clear(); updateTypingIndicator(); }, 3000);
    }
  });
  socket.on('stop_typing', ({ username: u }) => { typingUsers.delete(u); updateTypingIndicator(); });
  socket.on('daily_count_resp', (cnt) => { elements.statsToday.innerText = cnt; });
  socket.on('error', (err) => alert(`Error: ${err.message}`));

  // -------------------- UI Event Listeners --------------------
  elements.sendBtn.addEventListener('click', () => {
    const text = elements.messageInput.value.trim();
    if (text) {
      socket.emit('message', { room: currentRoom, username: currentUsername, text, replyTo: activeReply });
      elements.messageInput.value = '';
      activeReply = null;
      elements.replyPreview.classList.add('hidden');
    }
  });
  elements.messageInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') elements.sendBtn.click(); });
  elements.messageInput.addEventListener('input', () => {
    socket.emit('typing', { room: currentRoom, username: currentUsername });
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => socket.emit('stop_typing', { room: currentRoom, username: currentUsername }), 2000);
  });
  elements.cancelReply.addEventListener('click', () => { activeReply = null; elements.replyPreview.classList.add('hidden'); });
  elements.scrollBtn.addEventListener('click', () => scrollToBottom());
  elements.messagesDiv.addEventListener('scroll', () => { updateScrollButton(); });

  // Search
  elements.searchToggle.addEventListener('click', () => {
    elements.searchBar.classList.toggle('hidden');
    if (!elements.searchBar.classList.contains('hidden')) elements.searchInput.focus();
    else { if (originalMessagesHTML) elements.messagesDiv.innerHTML = originalMessagesHTML; elements.searchInput.value = ''; elements.searchCount.innerText = '0 results'; }
  });
  elements.searchInput.addEventListener('input', (e) => searchMessages(e.target.value));
  elements.closeSearch.addEventListener('click', () => { elements.searchBar.classList.add('hidden'); if (originalMessagesHTML) elements.messagesDiv.innerHTML = originalMessagesHTML; });

  // Image attachment
  elements.attachBtn.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (file.size > 5 * 1024 * 1024) { alert('Max 5MB'); return; }
      const reader = new FileReader();
      reader.onload = (ev) => {
        socket.emit('message', {
          room: currentRoom,
          username: currentUsername,
          text: '',
          replyTo: activeReply,
          media: { type: 'image', data: ev.target.result, filename: file.name, size: file.size }
        });
        activeReply = null;
        elements.replyPreview.classList.add('hidden');
      };
      reader.readAsDataURL(file);
    };
    input.click();
  });

  // Voice recording
  elements.voiceBtn.addEventListener('mousedown', startRecording);
  elements.voiceBtn.addEventListener('mouseup', stopRecording);
  elements.voiceBtn.addEventListener('mouseleave', stopRecording);

  // Theme toggle
  function setTheme(theme) {
    if (theme === 'light') {
      document.body.classList.add('light-theme');
      document.body.classList.remove('dark-theme');
      elements.themeToggle.innerText = '☀️';
      localStorage.setItem('zaptalk_theme', 'light');
    } else {
      document.body.classList.add('dark-theme');
      document.body.classList.remove('light-theme');
      elements.themeToggle.innerText = '🌙';
      localStorage.setItem('zaptalk_theme', 'dark');
    }
  }
  const savedTheme = localStorage.getItem('zaptalk_theme');
  if (savedTheme === 'light') setTheme('light');
  else setTheme('dark');
  elements.themeToggle.addEventListener('click', () => {
    const isLight = document.body.classList.contains('light-theme');
    setTheme(isLight ? 'dark' : 'light');
  });

  // Sound toggle
  function setSound(enabled) {
    soundEnabled = enabled;
    localStorage.setItem('zaptalk_sound', enabled);
    elements.soundToggle.innerText = enabled ? '🔔' : '🔕';
  }
  setSound(soundEnabled);
  elements.soundToggle.addEventListener('click', () => setSound(!soundEnabled));

  // Panels
  elements.toggleLeft.onclick = () => { elements.leftPanel.classList.add('open'); elements.leftOverlay.style.display = 'block'; };
  elements.closeLeft.onclick = () => { elements.leftPanel.classList.remove('open'); elements.leftOverlay.style.display = 'none'; };
  elements.leftOverlay.onclick = elements.closeLeft.onclick;
  elements.toggleRight.onclick = () => { elements.rightPanel.classList.add('open'); elements.rightOverlay.style.display = 'block'; };
  elements.closeRight.onclick = () => { elements.rightPanel.classList.remove('open'); elements.rightOverlay.style.display = 'none'; };
  elements.rightOverlay.onclick = elements.closeRight.onclick;

  // Quick join
  elements.quickJoinBtn.addEventListener('click', () => {
    const newRoom = elements.quickRoomCode.value.trim().toUpperCase();
    if (!newRoom) return;
    socket.emit('change_room', { room: newRoom, password: elements.quickPassword.value, username: currentUsername });
    elements.quickRoomCode.value = '';
    elements.quickPassword.value = '';
    elements.closeLeft.click();
  });

  // Emoji picker
  elements.emojiBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    elements.emojiPicker.classList.toggle('hidden');
  });
  document.querySelectorAll('#emojiPicker span').forEach(emoji => {
    emoji.addEventListener('click', () => {
      elements.messageInput.value += emoji.innerText;
      elements.messageInput.focus();
      elements.emojiPicker.classList.add('hidden');
    });
  });
  document.addEventListener('click', (e) => {
    if (!elements.emojiPicker.contains(e.target) && e.target !== elements.emojiBtn) elements.emojiPicker.classList.add('hidden');
  });

  // Lightbox close
  elements.lightbox.addEventListener('click', () => elements.lightbox.classList.add('hidden'));
  document.querySelector('.close-lightbox')?.addEventListener('click', () => elements.lightbox.classList.add('hidden'));

  // Ping for latency
  setInterval(() => {
    const start = Date.now();
    socket.emit('ping', (response) => {
      if (response && response.pong) elements.statsPing.innerText = Date.now() - start;
    });
  }, 3000);
  setInterval(() => { socket.emit('get_daily_count', currentRoom); }, 10000);

  // Request notification permission
  if ('Notification' in window && Notification.permission !== 'denied') {
    Notification.requestPermission().then(perm => { notificationPermission = perm === 'granted'; });
  }

  // Console easter egg
  console.log("%c⚡ ZAPTALK %c⚡\n%cReal-time anonymous chat with AI, media, and privacy.\n%cMade with 💻 by ZapTeam",
    "color: #00fff9; font-size: 16px; font-family: monospace;",
    "color: #bf00ff; font-size: 16px;",
    "color: #d0e8f0; font-size: 12px;",
    "color: #ff006e; font-size: 10px;");

  // Initial join
  socket.emit('join', { room: currentRoom, username: currentUsername, password: storedPassword, settings: storedSettings });
})();
