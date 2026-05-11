/* WeQuiz Player View */

// ── SoundManager ──────────────────────────────────────────────────────────────

const SoundManager = (() => {
  let ctx = null;
  let muted = localStorage.getItem('wequiz_muted') === 'true';

  // Pre-warm AudioContext on the first user gesture so socket-driven sounds
  // (question_start etc.) play without hitting the browser autoplay block.
  function _unlock() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    ['click', 'touchstart', 'keydown'].forEach(ev =>
      document.removeEventListener(ev, _unlock, true));
  }
  ['click', 'touchstart', 'keydown'].forEach(ev =>
    document.addEventListener(ev, _unlock, { capture: true }));

  function getCtx() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function tone(freq, type, startTime, duration, gainVal, endFreq) {
    const c = getCtx();
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.connect(g);
    g.connect(c.destination);
    osc.type = type;
    osc.frequency.setValueAtTime(freq, startTime);
    if (endFreq !== undefined) osc.frequency.linearRampToValueAtTime(endFreq, startTime + duration);
    g.gain.setValueAtTime(gainVal, startTime);
    g.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
    osc.start(startTime);
    osc.stop(startTime + duration + 0.02);
  }

  return {
    get muted() { return muted; },

    toggleMute() {
      muted = !muted;
      localStorage.setItem('wequiz_muted', String(muted));
      return muted;
    },

    questionDing() {
      if (muted) return;
      const now = getCtx().currentTime;
      tone(440, 'sine', now, 0.08, 0.35);
      tone(660, 'sine', now + 0.09, 0.18, 0.35);
    },

    tapClick() {
      if (muted) return;
      const now = getCtx().currentTime;
      tone(900, 'square', now, 0.06, 0.18, 500);
    },

    correctChime() {
      if (muted) return;
      const now = getCtx().currentTime;
      tone(523, 'sine', now, 0.18, 0.45);        // C5
      tone(784, 'sine', now + 0.20, 0.30, 0.45); // G5
    },

    wrongBuzzer() {
      if (muted) return;
      const now = getCtx().currentTime;
      tone(280, 'sawtooth', now, 0.35, 0.35, 130);
    },

    tick() {
      if (muted) return;
      const now = getCtx().currentTime;
      tone(1050, 'sine', now, 0.07, 0.12);
    },

    reveal() {
      if (muted) return;
      const now = getCtx().currentTime;
      // Rising arpeggio: C4 E4 G4 C5
      [262, 330, 392, 523].forEach((freq, i) => {
        tone(freq, 'sine', now + i * 0.09, i < 3 ? 0.09 : 0.40, 0.38);
      });
    },
  };
})();

// ─────────────────────────────────────────────────────────────────────────────

// ── ChatManager ───────────────────────────────────────────────────────────────

const CHAT_COLORS = ['#e21b3c','#1368ce','#d89e00','#26890c','#c084fc','#f97316','#06b6d4','#ec4899'];

function chatNameColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xfffffff;
  return CHAT_COLORS[h % CHAT_COLORS.length];
}

function timeAgo(ts) {
  const diff = Math.floor(Date.now() / 1000 - ts);
  if (diff < 10) return 'just now';
  if (diff < 60) return `${diff}s ago`;
  return `${Math.floor(diff / 60)}m ago`;
}

let chatOpen = false;
let chatUnread = 0;
let chatMsgCount = 0;
const MAX_CHAT = 50;

function initChat() {
  document.getElementById('chat-fab').addEventListener('click', toggleChat);
  document.getElementById('chat-close-btn').addEventListener('click', closeChat);
  document.getElementById('chat-backdrop').addEventListener('click', closeChat);
  document.getElementById('chat-send-btn').addEventListener('click', () => sendChatMsg());
  document.getElementById('chat-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); sendChatMsg(); }
  });
  document.querySelectorAll('.chat-emoji-btn').forEach(btn => {
    btn.addEventListener('click', () => { if (!btn.disabled) sendChatMsg(btn.dataset.emoji); });
  });
}

function toggleChat() { chatOpen ? closeChat() : openChat(); }

function openChat() {
  chatOpen = true;
  document.getElementById('chat-drawer').classList.add('open');
  document.getElementById('chat-backdrop').classList.add('open');
  chatUnread = 0;
  updateChatBadge();
  updateChatInputState();
  scrollChatBottom();
}

function closeChat() {
  chatOpen = false;
  document.getElementById('chat-drawer').classList.remove('open');
  document.getElementById('chat-backdrop').classList.remove('open');
}

function updateChatBadge() {
  const badge = document.getElementById('chat-badge');
  if (chatUnread > 0) {
    badge.textContent = chatUnread > 99 ? '99+' : chatUnread;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

function updateChatInputState() {
  const input = document.getElementById('chat-input');
  const sendBtn = document.getElementById('chat-send-btn');
  const disabled = questionActive;
  input.disabled = disabled;
  sendBtn.disabled = disabled;
  document.querySelectorAll('.chat-emoji-btn').forEach(b => { b.disabled = disabled; });
  input.placeholder = disabled ? 'Answer the question first! ⏳' : 'Say something…';
}

function sendChatMsg(override) {
  if (questionActive) return;
  const input = document.getElementById('chat-input');
  const msg = (override !== undefined ? override : input.value).trim();
  if (!msg) return;
  socket.emit('chat_message', { room_code: roomCode, message: msg, isHost: false });
  if (override === undefined) { input.value = ''; input.focus(); }
}

function appendChatMsg(entry) {
  const { playerName, message, isHost, timestamp } = entry;
  const list = document.getElementById('chat-messages');
  const emptyEl = document.getElementById('chat-empty');
  if (emptyEl) emptyEl.remove();

  const color = isHost ? '#f59e0b' : chatNameColor(playerName);
  const bg = color + '22';
  const div = document.createElement('div');
  div.className = 'chat-msg';
  div.innerHTML =
    `<div class="chat-msg-meta">` +
      `<span class="chat-msg-name" style="color:${color};background:${bg}">${escHtml(playerName)}</span>` +
      `<span class="chat-msg-time">${timeAgo(timestamp)}</span>` +
    `</div>` +
    `<div class="chat-msg-text">${escHtml(message)}</div>`;
  list.appendChild(div);
  chatMsgCount++;

  if (chatMsgCount > MAX_CHAT) {
    const first = list.querySelector('.chat-msg');
    if (first) { first.remove(); chatMsgCount--; }
  }

  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  if (atBottom || chatOpen) scrollChatBottom();
}

function scrollChatBottom() {
  const list = document.getElementById('chat-messages');
  list.scrollTop = list.scrollHeight;
}

function clearChatMsgs() {
  chatMsgCount = 0;
  document.getElementById('chat-messages').innerHTML =
    '<div class="chat-empty" id="chat-empty">No messages yet</div>';
}

// ─────────────────────────────────────────────────────────────────────────────

const socket = io();
const CIRCUMFERENCE = 2 * Math.PI * 36;  // r=36

let roomCode = '';
let nickname = '';
let timerInterval = null;
let questionActive = false;

// ── Screens ───────────────────────────────────────────────────────────────────

const SCREENS = ['join', 'lobby', 'question', 'result', 'reveal', 'leaderboard', 'final'];

function showScreen(name) {
  SCREENS.forEach(s => {
    const el = document.getElementById(`screen-${s}`);
    if (el) el.classList.toggle('hidden', s !== name);
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  const muteBtn = document.getElementById('mute-btn');
  muteBtn.textContent = SoundManager.muted ? '🔇' : '🔊';
  muteBtn.addEventListener('click', () => {
    muteBtn.textContent = SoundManager.toggleMute() ? '🔇' : '🔊';
  });

  initChat();

  // Pre-fill from URL params (coming from home page)
  const params = new URLSearchParams(window.location.search);
  const preCode = params.get('code');
  const preNick = params.get('nick');

  if (preCode) document.getElementById('room-code').value = preCode;
  if (preNick) document.getElementById('nickname').value = preNick;

  // Auto-join if both provided
  if (preCode && preNick) {
    attemptJoin(preCode, preNick);
  }

  document.getElementById('join-form').addEventListener('submit', e => {
    e.preventDefault();
    const code = document.getElementById('room-code').value.trim().toUpperCase();
    const nick = document.getElementById('nickname').value.trim();
    if (!code || !nick) {
      showJoinError('Please enter both a room code and a nickname.');
      return;
    }
    attemptJoin(code, nick);
  });
});

function attemptJoin(code, nick) {
  roomCode = code;
  nickname = nick;
  hideJoinError();
  document.getElementById('join-btn').textContent = 'Joining…';
  document.getElementById('join-btn').disabled = true;
  socket.emit('player_join', { room_code: code, nickname: nick });
}

// ── Socket events ─────────────────────────────────────────────────────────────

socket.on('join_success', data => {
  nickname = data.nickname;
  roomCode = data.room_code;
  document.getElementById('lobby-nick').textContent = data.nickname;
  document.getElementById('lobby-room-label').textContent = `Room: ${data.room_code}`;
  showScreen('lobby');
  document.getElementById('join-btn').textContent = 'Join Game →';
  document.getElementById('join-btn').disabled = false;
  document.getElementById('chat-fab').style.display = '';
});

socket.on('join_error', data => {
  showJoinError(data.message);
  document.getElementById('join-btn').textContent = 'Join Game →';
  document.getElementById('join-btn').disabled = false;
});

socket.on('player_joined', data => {
  // Update player count on lobby screen
  document.getElementById('lobby-player-count').textContent =
    `${data.players.length} player${data.players.length !== 1 ? 's' : ''} in room`;
});

socket.on('question_start', data => {
  stopTimer();
  questionActive = true;
  updateChatInputState();
  showScreen('question');
  SoundManager.questionDing();

  document.getElementById('q-counter').textContent = `Q ${data.q_num}/${data.total}`;
  document.getElementById('question-text').textContent = data.question;

  // Fill choices and re-enable buttons
  const shapes = ['▲', '◆', '●', '■'];
  for (let i = 0; i < 4; i++) {
    document.getElementById(`choice-${i}-text`).textContent = data.choices[i] || '';
    const btn = document.querySelector(`.answer-btn[data-idx="${i}"]`);
    btn.disabled = false;
    btn.classList.remove('correct', 'wrong');
    btn.querySelector('.answer-shape').textContent = shapes[i];
    btn.onclick = () => submitAnswer(i, data.choices, data.correct_idx_hidden);
  }

  startTimer(data.time_limit);
});

socket.on('answer_result', data => {
  stopTimer();
  questionActive = false;
  updateChatInputState();
  if (data.correct) SoundManager.correctChime(); else SoundManager.wrongBuzzer();
  showScreen('result');

  document.getElementById('result-icon').textContent = data.correct ? '🎉' : '😬';
  document.getElementById('result-title').textContent = data.correct ? 'Correct!' : 'Wrong!';
  document.getElementById('result-score').textContent = data.correct
    ? `+${data.score.toLocaleString()} points`
    : 'No points this round';
  document.getElementById('result-total').textContent =
    `Total: ${data.total_score.toLocaleString()}`;
});

socket.on('show_leaderboard', data => {
  stopTimer();
  questionActive = false;
  updateChatInputState();
  showReveal(data);
  SoundManager.reveal();
  setTimeout(() => {
    showScreen('leaderboard');
    renderLeaderboard('leaderboard-list', data.leaderboard, data.correct_text, nickname);
  }, 3000);
});

socket.on('game_over', data => {
  stopTimer();
  questionActive = false;
  updateChatInputState();
  showScreen('final');
  renderFinal('final-lb-list', data.leaderboard, nickname);
});

socket.on('disconnect', () => {
  if (questionActive) {
    // Could show reconnection UI, for now just note it
    console.warn('Disconnected from server');
  }
});

// ── Answer submission ─────────────────────────────────────────────────────────

function submitAnswer(idx, choices, _) {
  if (!questionActive) return;
  questionActive = false;
  updateChatInputState();
  stopTimer();
  SoundManager.tapClick();

  // Disable all buttons
  document.querySelectorAll('.answer-btn').forEach(btn => {
    btn.disabled = true;
  });
  // Dim the unchosen ones
  document.querySelectorAll('.answer-btn').forEach(btn => {
    if (parseInt(btn.dataset.idx) !== idx) btn.classList.add('wrong');
  });

  socket.emit('submit_answer', { room_code: roomCode, answer: idx });
}

// ── Timer ─────────────────────────────────────────────────────────────────────

function startTimer(seconds) {
  const circle = document.getElementById('timer-circle');
  const text = document.getElementById('timer-text');
  circle.style.strokeDasharray = CIRCUMFERENCE;
  circle.style.strokeDashoffset = 0;
  circle.style.stroke = 'white';
  let remaining = seconds;
  text.textContent = seconds;

  timerInterval = setInterval(() => {
    remaining = Math.max(0, remaining - 1);
    const pct = remaining / seconds;
    circle.style.strokeDashoffset = CIRCUMFERENCE * (1 - pct);
    text.textContent = remaining;

    if (remaining <= 5) {
      circle.style.stroke = '#e21b3c';
      if (remaining > 0) SoundManager.tick();
    } else if (remaining <= 10) circle.style.stroke = '#f0b000';
    else circle.style.stroke = 'white';

    if (remaining === 0) {
      stopTimer();
      if (questionActive) {
        // Time ran out without answering
        questionActive = false;
        updateChatInputState();
        document.querySelectorAll('.answer-btn').forEach(b => b.disabled = true);
        // Show "time's up" result briefly
        showScreen('result');
        document.getElementById('result-icon').textContent = '⏰';
        document.getElementById('result-title').textContent = "Time's Up!";
        document.getElementById('result-score').textContent = 'No points this round';
        document.getElementById('result-total').textContent = '';
      }
    }
  }, 1000);
}

function stopTimer() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}

// ── Reveal screen ─────────────────────────────────────────────────────────────

function showReveal(data) {
  showScreen('reveal');
  document.getElementById('reveal-answer-text').textContent = data.correct_text;

  const correctChips = (data.correct_players || []).map((n, i) => {
    const isMe = n === nickname;
    return `<div class="reveal-chip reveal-chip-correct${isMe ? ' reveal-chip-you' : ''}"
      style="animation-delay:${i * 70}ms">${escHtml(n)}</div>`;
  }).join('');

  const wrongChips = (data.wrong_players || []).map((n, i) => {
    const isMe = n === nickname;
    return `<div class="reveal-chip reveal-chip-wrong${isMe ? ' reveal-chip-you' : ''}"
      style="animation-delay:${i * 70}ms">${escHtml(n)}</div>`;
  }).join('');

  const correct = data.correct_players || [];
  const wrong = data.wrong_players || [];
  document.getElementById('reveal-groups').innerHTML = `
    ${correct.length > 0 ? `
      <div class="reveal-group reveal-group-correct">
        <div class="reveal-group-header">🎉 Got it! (${correct.length})</div>
        <div class="reveal-chips">${correctChips}</div>
      </div>` : ''}
    ${wrong.length > 0 ? `
      <div class="reveal-group reveal-group-wrong">
        <div class="reveal-group-header">😬 Missed it (${wrong.length})</div>
        <div class="reveal-chips">${wrongChips}</div>
      </div>` : ''}
  `;
}

// ── Leaderboard rendering ─────────────────────────────────────────────────────

function renderLeaderboard(containerId, lb, correctText, myNick) {
  const medals = ['🥇', '🥈', '🥉'];
  const el = document.getElementById(containerId);
  el.innerHTML = `
    <div class="leaderboard-header">📊 Leaderboard</div>
    <div class="leaderboard-correct">Answer: <strong>${escHtml(correctText)}</strong></div>
    ${lb.slice(0, 10).map((p, i) => `
      <div class="lb-entry" style="animation-delay:${i * 60}ms;${p.nickname === myNick ? 'border-color:rgba(192,132,252,0.6);background:rgba(192,132,252,0.15);' : ''}">
        <div class="lb-rank">${medals[i] || (i + 1)}</div>
        <div class="lb-name">${escHtml(p.nickname)}${p.nickname === myNick ? ' <span style="color:#c084fc;font-size:0.75rem;">(you)</span>' : ''}</div>
        <div class="lb-score">${p.score.toLocaleString()}</div>
      </div>
    `).join('')}
  `;
}

function renderFinal(containerId, lb, myNick) {
  const medals = ['🥇', '🥈', '🥉'];
  const myRank = lb.findIndex(p => p.nickname === myNick) + 1;
  const el = document.getElementById(containerId);

  let myRankMsg = '';
  if (myRank > 0) {
    const msg = myRank === 1 ? '🏆 You won!' : myRank === 2 ? '🥈 So close!' : myRank === 3 ? '🥉 Top 3!' : `You finished #${myRank}`;
    myRankMsg = `<div style="text-align:center;font-size:1.1rem;font-weight:800;margin-bottom:16px;color:#c084fc;">${msg}</div>`;
  }

  el.innerHTML = myRankMsg + lb.slice(0, 10).map((p, i) => `
    <div class="lb-entry" style="animation-delay:${i * 80}ms;${p.nickname === myNick ? 'border-color:rgba(192,132,252,0.6);background:rgba(192,132,252,0.15);' : ''}">
      <div class="lb-rank">${medals[i] || (i + 1)}</div>
      <div class="lb-name">${escHtml(p.nickname)}${p.nickname === myNick ? ' <span style="color:#c084fc;font-size:0.75rem;">(you)</span>' : ''}</div>
      <div class="lb-score">${p.score.toLocaleString()}</div>
    </div>
  `).join('');
}

// ── Chat socket events ────────────────────────────────────────────────────────

socket.on('new_chat_message', entry => {
  appendChatMsg(entry);
  if (!chatOpen) {
    chatUnread++;
    updateChatBadge();
  }
});

socket.on('chat_history', data => {
  (data.messages || []).forEach(m => appendChatMsg(m));
  scrollChatBottom();
});

socket.on('chat_cleared', () => {
  clearChatMsgs();
});

// ── Utilities ─────────────────────────────────────────────────────────────────

function showJoinError(msg) {
  const el = document.getElementById('join-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}
function hideJoinError() {
  document.getElementById('join-error').classList.add('hidden');
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
