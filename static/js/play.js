/* WeQuiz Player View */

const socket = io();
const CIRCUMFERENCE = 2 * Math.PI * 36;  // r=36

let roomCode = '';
let nickname = '';
let timerInterval = null;
let questionActive = false;

// ── Screens ───────────────────────────────────────────────────────────────────

const SCREENS = ['join', 'lobby', 'question', 'result', 'leaderboard', 'final'];

function showScreen(name) {
  SCREENS.forEach(s => {
    const el = document.getElementById(`screen-${s}`);
    if (el) el.classList.toggle('hidden', s !== name);
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
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
  // Reset button state
  document.getElementById('join-btn').textContent = 'Join Game →';
  document.getElementById('join-btn').disabled = false;
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
  showScreen('question');

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
  showScreen('leaderboard');
  renderLeaderboard('leaderboard-list', data.leaderboard, data.correct_text, nickname);
});

socket.on('game_over', data => {
  stopTimer();
  questionActive = false;
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
  stopTimer();

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

    if (remaining <= 5) circle.style.stroke = '#e21b3c';
    else if (remaining <= 10) circle.style.stroke = '#f0b000';
    else circle.style.stroke = 'white';

    if (remaining === 0) {
      stopTimer();
      if (questionActive) {
        // Time ran out without answering
        questionActive = false;
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
