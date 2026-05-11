/* WeQuiz Host View */

// ── SoundManager ──────────────────────────────────────────────────────────────

const SoundManager = (() => {
  let ctx = null;
  let muted = localStorage.getItem('wequiz_muted') === 'true';

  // Pre-warm AudioContext on the first user gesture so socket-driven sounds
  // (player_joined, question_start etc.) play without hitting the autoplay block.
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

    // Soft pop — quick sine blip rising
    playerJoin() {
      if (muted) return;
      const now = getCtx().currentTime;
      tone(320, 'sine', now, 0.06, 0.22, 600);
    },

    // Short 4-note ascending fanfare: C4 E4 G4 C5
    gameStart() {
      if (muted) return;
      const now = getCtx().currentTime;
      const notes = [262, 330, 392, 523];
      notes.forEach((freq, i) => {
        const t = now + i * 0.13;
        tone(freq, 'sine', t, i < 3 ? 0.12 : 0.35, 0.4);
      });
    },

    // Descending sawtooth whoosh + rising sine
    questionReveal() {
      if (muted) return;
      const now = getCtx().currentTime;
      tone(1800, 'sawtooth', now, 0.28, 0.18, 90);
      tone(220, 'sine', now + 0.05, 0.20, 0.12, 440);
    },

    // Podium fanfare: G4 B4 D5 G5
    leaderboard() {
      if (muted) return;
      const now = getCtx().currentTime;
      const notes = [392, 494, 587, 784];
      notes.forEach((freq, i) => {
        const t = now + i * 0.14;
        tone(freq, 'sine', t, i < 3 ? 0.13 : 0.45, 0.4);
      });
    },

    // Celebratory run: C5 E5 G5 C6, then short chord (C5+E5+G5)
    gameOver() {
      if (muted) return;
      const now = getCtx().currentTime;
      [523, 659, 784, 1047].forEach((freq, i) => {
        tone(freq, 'sine', now + i * 0.11, 0.10, 0.35);
      });
      // Final chord
      [523, 659, 784].forEach(freq => {
        tone(freq, 'sine', now + 0.50, 0.42, 0.25);
      });
    },
  };
})();

// ─────────────────────────────────────────────────────────────────────────────

// ── ChatManager (host) ────────────────────────────────────────────────────────

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
    btn.addEventListener('click', () => sendChatMsg(btn.dataset.emoji));
  });
  document.getElementById('chat-clear-btn').addEventListener('click', () => {
    socket.emit('chat_clear', { room_code: ROOM_CODE });
  });
}

function toggleChat() { chatOpen ? closeChat() : openChat(); }

function openChat() {
  chatOpen = true;
  document.getElementById('chat-drawer').classList.add('open');
  document.getElementById('chat-backdrop').classList.add('open');
  chatUnread = 0;
  updateChatBadge();
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

function sendChatMsg(override) {
  const input = document.getElementById('chat-input');
  const msg = (override !== undefined ? override : input.value).trim();
  if (!msg) return;
  socket.emit('chat_message', { room_code: ROOM_CODE, message: msg, isHost: true });
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

let timerInterval = null;
let currentTimeLimit = 20;
let totalPlayers = 0;

// ── Screens ───────────────────────────────────────────────────────────────────

const screens = ['lobby', 'question', 'reveal', 'leaderboard', 'final'];

function showScreen(name) {
  screens.forEach(s => {
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

  document.getElementById('join-url').textContent =
    window.location.hostname + (window.location.port ? ':' + window.location.port : '');

  document.getElementById('btn-start').addEventListener('click', () => {
    SoundManager.gameStart();
    socket.emit('host_start_game', { room_code: ROOM_CODE });
  });
  document.getElementById('btn-next').addEventListener('click', () => {
    socket.emit('host_next_question', { room_code: ROOM_CODE });
    document.getElementById('btn-next').style.display = 'none';
  });
  document.getElementById('btn-end-q').addEventListener('click', () => {
    socket.emit('host_end_question', { room_code: ROOM_CODE });
    document.getElementById('btn-end-q').style.display = 'none';
  });

  socket.emit('host_connect', { room_code: ROOM_CODE });
});

// ── Socket events ─────────────────────────────────────────────────────────────

socket.on('host_room_info', data => {
  document.getElementById('hdr-set-name').textContent = data.set_name;
  document.getElementById('lobby-set-name').textContent = `Set: ${data.set_name}`;
  updateLobby(data.players);
  if (data.state === 'lobby') showScreen('lobby');
});

socket.on('player_joined', data => {
  SoundManager.playerJoin();
  updateLobby(data.players);
});

socket.on('player_left', data => {
  updateLobby(data.players);
});

socket.on('question_start', data => {
  stopTimer();
  showScreen('question');
  SoundManager.questionReveal();
  document.getElementById('btn-end-q').style.display = 'inline-flex';
  document.getElementById('btn-next').style.display = 'none';
  document.getElementById('hq-counter').textContent = `Q ${data.q_num}/${data.total}`;
  document.getElementById('hq-text').textContent = data.question;
  document.getElementById('hq-answered').textContent = `0/${totalPlayers} answered`;

  const choicesEl = document.getElementById('hq-choices');
  const shapes = ['▲', '◆', '●', '■'];
  choicesEl.innerHTML = data.choices.map((c, i) => `
    <div class="host-choice" data-idx="${i}">
      <span style="font-size:1rem;opacity:0.7;">${shapes[i]}</span>
      ${escHtml(c)}
    </div>
  `).join('');

  currentTimeLimit = data.time_limit;
  startTimer(data.time_limit);
});

socket.on('answer_count', data => {
  totalPlayers = data.total;
  document.getElementById('hq-answered').textContent =
    `${data.answered}/${data.total} answered`;
});

socket.on('show_leaderboard', data => {
  stopTimer();
  document.getElementById('btn-end-q').style.display = 'none';
  showScreen('reveal');
  showReveal(data);

  setTimeout(() => {
    showScreen('leaderboard');
    SoundManager.leaderboard();
    renderLeaderboard('host-lb', data.leaderboard, data.correct_text, data.is_last);
    if (!data.is_last) {
      document.getElementById('btn-next').style.display = 'inline-flex';
    }
  }, 3000);
});

socket.on('game_over', data => {
  stopTimer();
  document.getElementById('btn-end-q').style.display = 'none';
  document.getElementById('btn-next').style.display = 'none';
  showScreen('final');
  SoundManager.gameOver();
  renderFinal('final-lb', data.leaderboard);
});

socket.on('error', data => {
  alert(data.message);
});

// ── Lobby ─────────────────────────────────────────────────────────────────────

function updateLobby(players) {
  totalPlayers = players.length;
  document.getElementById('lobby-count').textContent = players.length;
  document.getElementById('lobby-players').innerHTML =
    players.map(n => `<div class="player-chip">${escHtml(n)}</div>`).join('');

  const startBtn = document.getElementById('btn-start');
  startBtn.disabled = players.length === 0;
  startBtn.textContent = players.length > 0
    ? `Start Game (${players.length} player${players.length !== 1 ? 's' : ''})`
    : 'Waiting for players…';
}

// ── Timer ─────────────────────────────────────────────────────────────────────

function startTimer(seconds) {
  const circle = document.getElementById('host-timer-circle');
  const text = document.getElementById('host-timer-text');
  circle.style.strokeDasharray = CIRCUMFERENCE;
  circle.style.strokeDashoffset = 0;
  let remaining = seconds;

  function tick() {
    remaining = Math.max(0, remaining - 1);
    const pct = remaining / seconds;
    circle.style.strokeDashoffset = CIRCUMFERENCE * (1 - pct);
    text.textContent = remaining;

    if (remaining <= 5) circle.style.stroke = '#e21b3c';
    else if (remaining <= 10) circle.style.stroke = '#f0b000';
    else circle.style.stroke = 'white';
  }

  timerInterval = setInterval(tick, 1000);
}

function stopTimer() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}

// ── Reveal screen ─────────────────────────────────────────────────────────────

function showReveal(data) {
  document.getElementById('host-reveal-answer-text').textContent = data.correct_text;

  const correctChips = (data.correct_players || []).map((n, i) =>
    `<div class="reveal-chip reveal-chip-correct" style="animation-delay:${i * 60}ms">${escHtml(n)}</div>`
  ).join('');
  const wrongChips = (data.wrong_players || []).map((n, i) =>
    `<div class="reveal-chip reveal-chip-wrong" style="animation-delay:${i * 60}ms">${escHtml(n)}</div>`
  ).join('');

  const correct = data.correct_players || [];
  const wrong = data.wrong_players || [];
  document.getElementById('host-reveal-groups').innerHTML = `
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

function renderLeaderboard(containerId, lb, correctText, isLast) {
  const medals = ['🥇', '🥈', '🥉'];
  const el = document.getElementById(containerId);
  el.innerHTML = `
    <div class="leaderboard-header">${isLast ? '🏆 Final Leaderboard' : '📊 Leaderboard'}</div>
    <div class="leaderboard-correct">Correct answer: <strong>${escHtml(correctText)}</strong></div>
    ${lb.slice(0, 10).map((p, i) => `
      <div class="lb-entry" style="animation-delay:${i * 60}ms">
        <div class="lb-rank">${medals[i] || (i + 1)}</div>
        <div class="lb-name">${escHtml(p.nickname)}</div>
        <div class="lb-score">${p.score.toLocaleString()}</div>
      </div>
    `).join('')}
  `;
}

function renderFinal(containerId, lb) {
  const medals = ['🥇', '🥈', '🥉'];
  const el = document.getElementById(containerId);
  el.innerHTML = lb.slice(0, 10).map((p, i) => `
    <div class="lb-entry" style="animation-delay:${i * 80}ms">
      <div class="lb-rank">${medals[i] || (i + 1)}</div>
      <div class="lb-name">${escHtml(p.nickname)}</div>
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

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
