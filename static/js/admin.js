/* WeQuiz Admin Panel */

let sets = [];
let editingSetId = null;

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  await loadSets();
  bindEvents();
}

// ── Data ──────────────────────────────────────────────────────────────────────

async function loadSets() {
  try {
    const res = await fetch('/api/sets');
    sets = await res.json();
    renderSetsGrid();
  } catch (e) {
    showStatus('Failed to load question sets.', 'error');
  }
}

function getSet(id) {
  return sets.find(s => s.id === id);
}

// ── Render ────────────────────────────────────────────────────────────────────

function renderSetsGrid() {
  const grid = document.getElementById('sets-grid');
  if (sets.length === 0) {
    grid.innerHTML = `<div style="opacity:0.45;padding:40px;text-align:center;font-weight:700;grid-column:1/-1;">
      No question sets yet. Click "+ New Question Set" to create one.
    </div>`;
    return;
  }
  grid.innerHTML = sets.map(s => `
    <div class="set-card" data-id="${s.id}">
      <div class="set-card-name">${escHtml(s.name)}</div>
      <div class="set-card-meta">${s.questions.length} question${s.questions.length !== 1 ? 's' : ''}</div>
      <div class="set-card-actions">
        <button class="btn btn-ghost" onclick="editSet('${s.id}')">✏️ Edit</button>
        <button class="btn btn-success" onclick="startGame('${s.id}')">▶ Launch</button>
        <button class="btn btn-danger" onclick="deleteSet('${s.id}')">🗑</button>
      </div>
    </div>
  `).join('');
}

function renderQuestionList() {
  const set = getSet(editingSetId);
  if (!set) return;

  const list = document.getElementById('question-list');
  const empty = document.getElementById('no-questions');

  if (set.questions.length === 0) {
    list.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  list.innerHTML = set.questions.map((q, i) => `
    <div class="question-item" data-qid="${q.id}">
      <div class="question-item-num">${i + 1}.</div>
      <div style="flex:1;">
        <div class="question-item-text">${escHtml(q.text)}</div>
        <div class="question-item-meta">
          Correct: <span style="color:#86efac;font-weight:800;">${escHtml(q.choices[q.correct])}</span>
          &nbsp;·&nbsp; ${q.time_limit}s
        </div>
      </div>
      <div class="question-item-actions">
        <button class="btn btn-ghost" onclick="openEditQuestion('${q.id}')">Edit</button>
        <button class="btn btn-danger" onclick="deleteQuestion('${q.id}')">✕</button>
      </div>
    </div>
  `).join('');
}

// ── Events ────────────────────────────────────────────────────────────────────

function bindEvents() {
  // New set
  document.getElementById('btn-new-set').addEventListener('click', () => {
    document.getElementById('new-set-name').value = '';
    document.getElementById('new-set-modal').classList.remove('hidden');
    setTimeout(() => document.getElementById('new-set-name').focus(), 50);
  });
  document.getElementById('new-set-cancel').addEventListener('click', () => {
    document.getElementById('new-set-modal').classList.add('hidden');
  });
  document.getElementById('new-set-create').addEventListener('click', createSet);
  document.getElementById('new-set-name').addEventListener('keydown', e => {
    if (e.key === 'Enter') createSet();
  });

  // Set editor
  document.getElementById('btn-close-editor').addEventListener('click', closeEditor);
  document.getElementById('btn-save-set').addEventListener('click', saveSetName);
  document.getElementById('btn-add-question').addEventListener('click', () => openAddQuestion());
  document.getElementById('editor-set-name').addEventListener('keydown', e => {
    if (e.key === 'Enter') saveSetName();
  });

  // Question modal
  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  document.getElementById('modal-save').addEventListener('click', saveQuestion);
  document.getElementById('q-modal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeModal();
  });
  document.getElementById('new-set-modal').addEventListener('click', e => {
    if (e.target === e.currentTarget) e.currentTarget.classList.add('hidden');
  });
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

async function createSet() {
  const name = document.getElementById('new-set-name').value.trim();
  if (!name) return;
  const res = await fetch('/api/sets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const newSet = await res.json();
  sets.push(newSet);
  renderSetsGrid();
  document.getElementById('new-set-modal').classList.add('hidden');
  editSet(newSet.id);
}

function editSet(id) {
  editingSetId = id;
  const set = getSet(id);
  document.getElementById('editor-set-name').value = set.name;
  document.getElementById('set-editor').classList.remove('hidden');
  document.getElementById('set-editor').scrollIntoView({ behavior: 'smooth' });
  renderQuestionList();
}

function closeEditor() {
  editingSetId = null;
  document.getElementById('set-editor').classList.add('hidden');
}

async function saveSetName() {
  const name = document.getElementById('editor-set-name').value.trim();
  if (!name || !editingSetId) return;
  const res = await fetch(`/api/sets/${editingSetId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const updated = await res.json();
  const idx = sets.findIndex(s => s.id === editingSetId);
  if (idx !== -1) sets[idx].name = updated.name;
  renderSetsGrid();
  showStatus('Set name saved!', 'success');
}

async function deleteSet(id) {
  const set = getSet(id);
  if (!confirm(`Delete "${set.name}"? This cannot be undone.`)) return;
  await fetch(`/api/sets/${id}`, { method: 'DELETE' });
  sets = sets.filter(s => s.id !== id);
  if (editingSetId === id) closeEditor();
  renderSetsGrid();
  showStatus('Set deleted.', 'success');
}

async function saveQuestionsToServer() {
  const set = getSet(editingSetId);
  await fetch(`/api/sets/${editingSetId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ questions: set.questions }),
  });
}

// ── Question modal ────────────────────────────────────────────────────────────

function openAddQuestion() {
  document.getElementById('modal-title').textContent = 'Add Question';
  document.getElementById('modal-q-id').value = '';
  document.getElementById('modal-q-text').value = '';
  document.getElementById('choice-0').value = '';
  document.getElementById('choice-1').value = '';
  document.getElementById('choice-2').value = '';
  document.getElementById('choice-3').value = '';
  document.getElementById('modal-time').value = '20';
  document.querySelectorAll('input[name="correct"]').forEach(r => r.checked = false);
  document.getElementById('modal-error').classList.add('hidden');
  document.getElementById('q-modal').classList.remove('hidden');
  setTimeout(() => document.getElementById('modal-q-text').focus(), 50);
}

function openEditQuestion(qid) {
  const set = getSet(editingSetId);
  const q = set.questions.find(q => q.id === qid);
  if (!q) return;
  document.getElementById('modal-title').textContent = 'Edit Question';
  document.getElementById('modal-q-id').value = qid;
  document.getElementById('modal-q-text').value = q.text;
  document.getElementById('choice-0').value = q.choices[0] || '';
  document.getElementById('choice-1').value = q.choices[1] || '';
  document.getElementById('choice-2').value = q.choices[2] || '';
  document.getElementById('choice-3').value = q.choices[3] || '';
  document.getElementById('modal-time').value = q.time_limit || 20;
  document.querySelectorAll('input[name="correct"]').forEach(r => {
    r.checked = parseInt(r.value) === q.correct;
  });
  document.getElementById('modal-error').classList.add('hidden');
  document.getElementById('q-modal').classList.remove('hidden');
}

function closeModal() {
  document.getElementById('q-modal').classList.add('hidden');
}

async function saveQuestion() {
  const text = document.getElementById('modal-q-text').value.trim();
  const choices = [0, 1, 2, 3].map(i => document.getElementById(`choice-${i}`).value.trim());
  const correctEl = document.querySelector('input[name="correct"]:checked');
  const timeLimit = parseInt(document.getElementById('modal-time').value) || 20;
  const errEl = document.getElementById('modal-error');

  if (!text) { showModalError('Please enter a question.'); return; }
  if (choices.some(c => !c)) { showModalError('Please fill in all 4 answers.'); return; }
  if (!correctEl) { showModalError('Please select the correct answer.'); return; }

  const correct = parseInt(correctEl.value);
  const set = getSet(editingSetId);
  const existingId = document.getElementById('modal-q-id').value;

  if (existingId) {
    const q = set.questions.find(q => q.id === existingId);
    if (q) { q.text = text; q.choices = choices; q.correct = correct; q.time_limit = timeLimit; }
  } else {
    set.questions.push({
      id: 'q_' + Date.now(),
      text, choices, correct,
      time_limit: timeLimit,
    });
  }

  await saveQuestionsToServer();
  renderQuestionList();
  renderSetsGrid();
  closeModal();
}

async function deleteQuestion(qid) {
  if (!confirm('Delete this question?')) return;
  const set = getSet(editingSetId);
  set.questions = set.questions.filter(q => q.id !== qid);
  await saveQuestionsToServer();
  renderQuestionList();
  renderSetsGrid();
}

// ── Start game ────────────────────────────────────────────────────────────────

async function startGame(setId) {
  const set = getSet(setId);
  if (set.questions.length === 0) {
    showStatus('Add at least one question before launching!', 'error');
    return;
  }
  const res = await fetch('/api/start-game', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ set_id: setId }),
  });
  const data = await res.json();
  if (data.room_code) {
    window.location.href = `/host/${data.room_code}`;
  } else {
    showStatus(data.error || 'Failed to start game.', 'error');
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function showStatus(msg, type = 'success') {
  const el = document.getElementById('status-msg');
  el.innerHTML = `<div class="${type === 'error' ? 'error-msg' : 'success-msg'}" style="margin-bottom:16px;">${escHtml(msg)}</div>`;
  setTimeout(() => el.innerHTML = '', 3000);
}

function showModalError(msg) {
  const el = document.getElementById('modal-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

init();
