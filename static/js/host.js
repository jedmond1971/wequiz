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

const socket = io();
const CIRCUMFERENCE = 2 * Math.PI * 36;  // r=36

let timerInterval = null;
let currentTimeLimit = 20;
let totalPlayers = 0;

// ── Screens ───────────────────────────────────────────────────────────────────

const screens = ['lobby', 'question', 'leaderboard', 'final'];

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

  // Highlight correct choice on question screen
  document.querySelectorAll('.host-choice').forEach(el => {
    const idx = parseInt(el.dataset.idx);
    el.classList.toggle('correct-choice', idx === data.correct_answer);
  });

  // Short delay to show correct answer, then go to leaderboard
  setTimeout(() => {
    showScreen('leaderboard');
    SoundManager.leaderboard();
    renderLeaderboard('host-lb', data.leaderboard, data.correct_text, data.is_last);

    if (!data.is_last) {
      document.getElementById('btn-next').style.display = 'inline-flex';
    }
  }, 1500);
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

// ── Utilities ─────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
