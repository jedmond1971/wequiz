/* WeQuiz Solo Mode */

// ── SoundManager (identical to play.js) ──────────────────────────────────────

const SoundManager = (() => {
  let ctx = null;
  let muted = localStorage.getItem('wequiz_muted') === 'true';

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
      tone(523, 'sine', now, 0.18, 0.45);
      tone(784, 'sine', now + 0.20, 0.30, 0.45);
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
    gameOver() {
      if (muted) return;
      const now = getCtx().currentTime;
      [523, 659, 784, 1047].forEach((freq, i) => {
        tone(freq, 'sine', now + i * 0.12, i < 3 ? 0.12 : 0.6, 0.4);
      });
    },
  };
})();

// ── State ─────────────────────────────────────────────────────────────────────

const CIRCUMFERENCE = 2 * Math.PI * 36;

let playerName = '';
let gameQuestions = [];
let currentIdx = 0;
let totalScore = 0;
let timerInterval = null;
let qStartTime = 0;
let questionActive = false;
let history = [];
let lastSetId = '';
let lastCount = 10;

// Sets cache from API
let setsCache = [];

// ── Screens ───────────────────────────────────────────────────────────────────

function showScreen(name) {
  ['setup', 'question', 'final'].forEach(s => {
    const el = document.getElementById(`screen-${s}`);
    if (el) el.classList.toggle('hidden', s !== name);
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  const muteBtn = document.getElementById('mute-btn');
  muteBtn.textContent = SoundManager.muted ? '🔇' : '🔊';
  muteBtn.addEventListener('click', () => {
    muteBtn.textContent = SoundManager.toggleMute() ? '🔇' : '🔊';
  });

  document.getElementById('setup-form').addEventListener('submit', e => {
    e.preventDefault();
    startGame();
  });

  document.getElementById('solo-set').addEventListener('change', onSetChange);
  document.getElementById('solo-count').addEventListener('input', onCountChange);

  await loadSets();
});

async function loadSets() {
  const sel = document.getElementById('solo-set');
  const startBtn = document.getElementById('start-btn');
  try {
    const res = await fetch('/api/public/sets');
    if (!res.ok) throw new Error('Failed to load');
    setsCache = await res.json();

    if (setsCache.length === 0) {
      sel.innerHTML = '<option value="">No question sets available</option>';
      return;
    }

    sel.innerHTML = setsCache.map(s =>
      `<option value="${escAttr(s.id)}">${escHtml(s.name)} (${s.question_count} Q)</option>`
    ).join('');

    onSetChange();
    startBtn.disabled = false;
  } catch {
    sel.innerHTML = '<option value="">Could not load sets</option>';
    showSetupError('Could not load question sets. Please refresh and try again.');
  }
}

function onSetChange() {
  const sel = document.getElementById('solo-set');
  const countInput = document.getElementById('solo-count');
  const set = setsCache.find(s => s.id === sel.value);
  if (!set) return;

  const max = set.question_count;
  countInput.max = max;
  const current = parseInt(countInput.value, 10);
  if (isNaN(current) || current < 1) {
    countInput.value = Math.min(10, max);
  } else if (current > max) {
    countInput.value = max;
  } else if (countInput.value === '10' || current > max) {
    countInput.value = Math.min(10, max);
  }
}

function onCountChange() {
  const sel = document.getElementById('solo-set');
  const countInput = document.getElementById('solo-count');
  const set = setsCache.find(s => s.id === sel.value);
  if (!set) return;
  const val = parseInt(countInput.value, 10);
  if (val > set.question_count) countInput.value = set.question_count;
  if (val < 1) countInput.value = 1;
}

// ── Game start ────────────────────────────────────────────────────────────────

async function startGame() {
  const nameInput = document.getElementById('solo-name');
  const setInput = document.getElementById('solo-set');
  const countInput = document.getElementById('solo-count');

  const name = nameInput.value.trim();
  const setId = setInput.value;
  const count = parseInt(countInput.value, 10);

  hideSetupError();

  if (!name) { showSetupError('Please enter your name.'); return; }
  if (!setId) { showSetupError('Please choose a question set.'); return; }
  if (isNaN(count) || count < 1) { showSetupError('Please enter a valid question count.'); return; }

  const startBtn = document.getElementById('start-btn');
  startBtn.textContent = 'Loading…';
  startBtn.disabled = true;

  try {
    const res = await fetch(`/api/public/sets/${encodeURIComponent(setId)}`);
    if (!res.ok) throw new Error('Not found');
    const setData = await res.json();
    const allQuestions = setData.questions || [];

    if (allQuestions.length === 0) {
      showSetupError('This set has no questions yet.');
      startBtn.textContent = 'Start →';
      startBtn.disabled = false;
      return;
    }

    // Shuffle questions (Fisher-Yates) and take the requested count
    const shuffled = [...allQuestions];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    gameQuestions = shuffled.slice(0, Math.min(count, shuffled.length));

    playerName = name;
    lastSetId = setId;
    lastCount = count;
    currentIdx = 0;
    totalScore = 0;
    history = [];

    startBtn.textContent = 'Start →';
    startBtn.disabled = false;

    showScreen('question');
    showQuestion(0);
  } catch {
    showSetupError('Could not load questions. Please try again.');
    startBtn.textContent = 'Start →';
    startBtn.disabled = false;
  }
}

// ── Question display ──────────────────────────────────────────────────────────

function showQuestion(idx) {
  currentIdx = idx;
  const q = gameQuestions[idx];

  document.getElementById('q-counter').textContent =
    `Q ${idx + 1}/${gameQuestions.length}`;
  document.getElementById('question-text').textContent = q.text;
  document.getElementById('solo-score-chip').textContent =
    totalScore.toLocaleString() + ' pts';

  const shapes = ['▲', '◆', '●', '■'];
  for (let i = 0; i < 4; i++) {
    document.getElementById(`choice-${i}-text`).textContent = q.choices[i] || '';
    const btn = document.querySelector(`.answer-btn[data-idx="${i}"]`);
    btn.disabled = false;
    btn.classList.remove('correct', 'wrong');
    btn.style.opacity = '';
    btn.querySelector('.answer-shape').textContent = shapes[i];
    btn.onclick = () => onAnswer(i);
  }

  document.getElementById('reveal-footer').classList.add('hidden');
  document.getElementById('answer-grid').classList.remove('reveal-open');

  SoundManager.questionDing();
  questionActive = true;
  qStartTime = Date.now();
  startTimer(q.time_limit || 20);
}

// ── Answer handling ───────────────────────────────────────────────────────────

function onAnswer(chosenIdx) {
  if (!questionActive) return;
  questionActive = false;
  stopTimer();

  if (chosenIdx !== null) SoundManager.tapClick();

  const q = gameQuestions[currentIdx];
  const timedOut = chosenIdx === null;
  const gotIt = !timedOut && chosenIdx === q.correct;
  const timeTaken = (Date.now() - qStartTime) / 1000;
  const timeLimit = q.time_limit || 20;
  const pts = gotIt
    ? Math.round(500 + 500 * Math.max(0, 1 - timeTaken / timeLimit))
    : 0;

  totalScore += pts;
  history.push({ text: q.text, choices: q.choices, correct: q.correct, chosen: chosenIdx, gotIt, pts, timedOut });

  // Highlight answers
  for (let i = 0; i < 4; i++) {
    const btn = document.querySelector(`.answer-btn[data-idx="${i}"]`);
    btn.disabled = true;
    if (i === q.correct) {
      btn.classList.add('correct');
    } else if (!timedOut && i === chosenIdx) {
      btn.classList.add('wrong');
    } else {
      btn.style.opacity = '0.3';
    }
  }

  // Feedback
  const feedback = document.getElementById('reveal-feedback');
  if (timedOut) {
    feedback.innerHTML = `<span class="solo-feedback-icon">⏰</span><span class="solo-feedback-text solo-feedback-wrong">Time's Up! No points</span>`;
    SoundManager.wrongBuzzer();
  } else if (gotIt) {
    feedback.innerHTML = `<span class="solo-feedback-icon">🎉</span><span class="solo-feedback-text solo-feedback-correct">Correct! +${pts.toLocaleString()} pts</span>`;
    SoundManager.correctChime();
  } else {
    feedback.innerHTML = `<span class="solo-feedback-icon">😬</span><span class="solo-feedback-text solo-feedback-wrong">Wrong! No points</span>`;
    SoundManager.wrongBuzzer();
  }

  document.getElementById('solo-score-chip').textContent =
    totalScore.toLocaleString() + ' pts';
  document.getElementById('answer-grid').classList.add('reveal-open');
  document.getElementById('reveal-footer').classList.remove('hidden');
}

// ── Navigation ────────────────────────────────────────────────────────────────

function nextQuestion() {
  if (currentIdx + 1 >= gameQuestions.length) {
    showFinal();
  } else {
    showQuestion(currentIdx + 1);
  }
}

function playAgain() {
  // Re-shuffle the same set and count without going back to setup
  const setId = lastSetId;
  const count = lastCount;

  fetch(`/api/public/sets/${encodeURIComponent(setId)}`)
    .then(r => r.json())
    .then(setData => {
      const allQuestions = setData.questions || [];
      const shuffled = [...allQuestions];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      gameQuestions = shuffled.slice(0, Math.min(count, shuffled.length));
      currentIdx = 0;
      totalScore = 0;
      history = [];
      showScreen('question');
      showQuestion(0);
    })
    .catch(() => {
      showScreen('setup');
    });
}

// ── Final screen ──────────────────────────────────────────────────────────────

function showFinal() {
  stopTimer();
  SoundManager.gameOver();
  showScreen('final');

  const correct = history.filter(h => h.gotIt).length;
  const total = history.length;

  document.getElementById('final-score-label').textContent =
    `${correct} / ${total} Correct`;
  document.getElementById('final-pts').textContent =
    totalScore.toLocaleString() + ' pts';

  const review = document.getElementById('final-review');
  review.innerHTML = history.map((h, i) => {
    const resultClass = h.gotIt ? 'solo-review-correct' : 'solo-review-wrong';
    const icon = h.gotIt ? '✓' : '✗';
    const iconClass = h.gotIt ? 'solo-review-icon-correct' : 'solo-review-icon-wrong';

    let answerLine;
    if (h.timedOut) {
      answerLine = `<span class="solo-review-chose">Timed out</span> · <span class="solo-review-right">Correct: ${escHtml(h.choices[h.correct])}</span>`;
    } else if (h.gotIt) {
      answerLine = `<span class="solo-review-chose">${escHtml(h.choices[h.chosen])}</span>`;
    } else {
      answerLine = `<span class="solo-review-chose">You chose: ${escHtml(h.choices[h.chosen])}</span> · <span class="solo-review-right">Correct: ${escHtml(h.choices[h.correct])}</span>`;
    }

    return `
      <div class="solo-review-item ${resultClass}" style="animation-delay:${i * 40}ms">
        <div class="solo-review-num">${i + 1}</div>
        <div class="solo-review-content">
          <div class="solo-review-qtext">${escHtml(h.text)}</div>
          <div class="solo-review-answer">${answerLine}</div>
        </div>
        <div class="solo-review-result ${iconClass}">${icon}${h.gotIt ? ` +${h.pts.toLocaleString()}` : ''}</div>
      </div>`;
  }).join('');
}

// ── Timer ─────────────────────────────────────────────────────────────────────

function startTimer(seconds) {
  const circle = document.getElementById('timer-circle');
  const text = document.getElementById('timer-text');

  circle.style.strokeDasharray = CIRCUMFERENCE;
  circle.style.strokeDashoffset = 0;
  circle.style.stroke = 'white';
  text.textContent = seconds;
  let remaining = seconds;

  timerInterval = setInterval(() => {
    remaining = Math.max(0, remaining - 1);
    const pct = remaining / seconds;
    circle.style.strokeDashoffset = CIRCUMFERENCE * (1 - pct);
    text.textContent = remaining;

    if (remaining <= 5) {
      circle.style.stroke = '#e21b3c';
      if (remaining > 0) SoundManager.tick();
    } else if (remaining <= 10) {
      circle.style.stroke = '#f0b000';
    } else {
      circle.style.stroke = 'white';
    }

    if (remaining === 0) {
      stopTimer();
      if (questionActive) onAnswer(null);
    }
  }, 1000);
}

function stopTimer() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}

// ── Setup form helpers ────────────────────────────────────────────────────────

function showSetupError(msg) {
  const el = document.getElementById('setup-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function hideSetupError() {
  document.getElementById('setup-error').classList.add('hidden');
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escAttr(str) {
  return String(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
