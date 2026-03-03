/* WeQuiz Host View */

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
  document.getElementById('join-url').textContent =
    window.location.hostname + (window.location.port ? ':' + window.location.port : '');

  document.getElementById('btn-start').addEventListener('click', () => {
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
  updateLobby(data.players);
});

socket.on('player_left', data => {
  updateLobby(data.players);
});

socket.on('question_start', data => {
  stopTimer();
  showScreen('question');
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
