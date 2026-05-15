# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running locally

```bash
pip install -r requirements.txt
python3 app.py
# Visit http://localhost:5000
```

Admin panel: `/admin` — default password `admin123` (set `ADMIN_PASSWORD` env var to override).

## Deploying

Push to `main` → Railway auto-deploys via `Procfile`. Set `ADMIN_PASSWORD`, `SECRET_KEY`, `DATABASE_URL`, and `ANTHROPIC_API_KEY` env vars in Railway dashboard. The Procfile uses gunicorn with a single eventlet worker — **do not increase to multiple workers**, as game state is in-memory and not shared between processes.

## Architecture

Everything lives in `app.py`: Flask HTTP routes, REST API, and all SocketIO event handlers. Active game rooms live in the `rooms = {}` dict in memory and are lost on restart.

### Storage

Two modes, selected automatically via the `DATABASE_URL` env var:

- **PostgreSQL** (when `DATABASE_URL` is set) — `db.py` handles all CRUD via psycopg2. `db.USE_DB = True`. Schema is created at startup via `init_schema()`.
- **JSON fallback** (no `DATABASE_URL`) — question sets persist in `data/questions.json`.

All HTTP routes call thin wrapper functions (`_get_set`, `_update_set`, etc.) that dispatch to the right backend. Never call `db.*` or JSON helpers directly from routes.

**Schema** (PostgreSQL):
- `question_sets (id TEXT PK, name TEXT)`
- `questions (id TEXT PK, set_id FK→question_sets CASCADE, text, choices JSONB, correct INT, time_limit INT, position INT)`
- `game_sessions (id TEXT PK, set_id TEXT, room_code TEXT, played_at TIMESTAMPTZ)` — no FK on set_id (historical data)
- `session_questions (session_id FK→game_sessions CASCADE, question_id TEXT)` — no FK on question_id (preserves rotation history when questions are edited)

Question IDs are TEXT (not UUID) because `admin.js` creates new questions with `'q_' + Date.now()`. AI-generated questions use `str(uuid.uuid4())`.

**Question rotation** (`db_get_questions_for_game`): questions ordered by `MAX(played_at) ASC NULLS FIRST`, then shuffled within tied groups via `itertools.groupby`. This surfaces least-recently-used questions first.

**Migration**: `migrate.py` creates tables (`python migrate.py`) and optionally seeds from `data/questions.json` (`python migrate.py --seed`). Safe to import — no side effects at module level.

### Game flow

1. Admin logs in → `/admin` (session cookie)
2. Admin clicks Launch on a set → `POST /api/start-game` → creates a room entry in `rooms`, returns a 6-char room code → redirects to `/host/<room_code>`
3. Host page opens a SocketIO connection (`host_connect`) and waits in lobby
4. Players go to `/play`, emit `player_join` with room code + nickname
5. Host emits `host_start_game` → server calls `_send_next_question(code)` in a loop
6. Each question: server emits `question_start` to the room, starts a background timer task via `socketio.start_background_task`; players submit via `submit_answer`; question ends either when all players answer (1.5s delay) or time expires
7. Server emits `show_leaderboard` → clients show **reveal screen** (3s) then leaderboard → host advances → repeat until all questions done → `game_over`

### SocketIO rooms

Each game uses two SocketIO rooms:
- `<room_code>` — all participants (host + players), receives `question_start`, `show_leaderboard`, `game_over`
- `host_<room_code>` — host only, receives `player_joined`, `player_left`, `answer_count`

### Scoring

`int(500 + 500 * max(0, 1 - time_taken / time_limit))` — correct answers score 500–1000 points scaled by speed; wrong answers score 0.

### Questions data format

`data/questions.json` structure:
```json
{
  "sets": [{
    "id": "slug-or-uuid",
    "name": "Set Name",
    "questions": [{
      "id": "q1",
      "text": "Question?",
      "choices": ["A", "B", "C", "D"],
      "correct": 1,
      "time_limit": 20
    }]
  }]
}
```
`correct` is a **0-based index** into `choices`. Always exactly 4 choices.

### Frontend JS files

- `admin.js` — SPA for managing question sets; holds full set state in a `sets` array in memory; writes to server on every change via `PUT /api/sets/<id>`; includes AI question generator (see below)
- `host.js` — manages host screen transitions (lobby → question → **reveal** → leaderboard → final); `ROOM_CODE` is injected as a global from the template
- `play.js` — manages player screen transitions (join → lobby → question → result → **reveal** → leaderboard → final); supports auto-join via `?code=X&nick=Y` URL params

### Timer

Client-side only (animated SVG ring, `r=36`, `circumference=226`). The server runs its own independent timer via `_question_timer` background task — the client timer is purely cosmetic. Color changes: white → amber at ≤10s → red at ≤5s.

### Sound effects

Both `host.js` and `play.js` contain a `SoundManager` IIFE at the top. All sounds are generated via Web Audio API (`AudioContext` + `OscillatorNode`) — no audio files.

- AudioContext is pre-warmed on the first user gesture (`click`/`touchstart`/`keydown`) so that socket-driven sounds don't hit the browser autoplay block.
- Mute state persists in `localStorage` under the key `wequiz_muted` (shared between host and player so the preference carries across screens).
- A mute toggle button (`🔊/🔇`) is rendered in both `host.html` and `play.html`.

**play.js sounds:** `questionDing` (question appears), `tapClick` (answer tapped), `correctChime` / `wrongBuzzer` (result), `tick` (countdown ≤5s), `reveal` (answer reveal screen).

**host.js sounds:** `playerJoin` (lobby), `gameStart` (start button), `questionReveal` (question live), `leaderboard` (leaderboard screen), `gameOver` (final screen).

### Answer reveal screen

After each question ends, a 3-second reveal screen appears on both host and player views before the leaderboard. It shows:
- The correct answer text in green with a pop animation
- Two chip groups: **🎉 Got it!** (correct players) and **😬 Missed it** (wrong/unanswered)
- Players listed as animated chips with staggered pop-in delays
- On the player view, the current player's own chip is outlined for self-identification

The `show_leaderboard` event payload includes `correct_players` and `wrong_players` string lists (built in `_end_question` from `room['round_answers']`; players who didn't answer are counted as wrong).

### Group chat

A persistent in-room chat is available to all participants from lobby through game over. Messages are kept in `room['chat_log']` (rolling 50-message list) and cleared when the room is destroyed on restart.

**Socket events:**
- `chat_message` (client → server): `{ room_code, message, isHost }` — server validates sender, enforces 80-char cap, appends to `chat_log`, broadcasts `new_chat_message` with `{ playerName, message, isHost, timestamp }` to all in room
- `chat_clear` (host → server): clears `chat_log`, broadcasts `chat_cleared` to all clients
- `chat_history` (server → joining client): emitted on `player_join` success and `host_connect` with the current `chat_log` so late joiners see prior messages

**UI — both views:**
- Fixed 💬 FAB (bottom-right, `z-index: 930`) with an unread badge counter
- Bottom sheet on mobile (42% height, slides up); fixed 300px sidebar on desktop (`@media (min-width: 640px)`)
- Quick-tap emoji bar: 🔥 😂 💀 👏 😬 🫡
- Name labels use a consistent hash-based colour from an 8-colour palette; host messages always appear in gold (`#f59e0b`)
- FAB is hidden on `play.html` until after `join_success`

**Player-specific behaviour:**
- Input and emoji buttons are **disabled during active questions** (`questionActive === true`) with placeholder "Answer the question first! ⏳"; re-enabled on `answer_result`, `show_leaderboard`, `game_over`, or timer expiry

**Host-specific behaviour:**
- Input is never disabled; messages are labelled "Host 🎤"
- "Clear" button in the drawer header emits `chat_clear`

### AI question generator

`POST /admin/generate-questions` (admin-only) accepts `{ set_id, category, difficulty, count }` and calls `claude-opus-4-7` to generate multiple-choice questions. Requires `ANTHROPIC_API_KEY` env var.

- Fetches existing questions for the set first and includes their texts in the prompt to avoid duplicates
- Parses the JSON array response, validates each question, and appends them to the set via `_update_set`
- Returns `{ added, questions }`

**Admin UI** (`admin.html` / `admin.js`): standalone **✨ Generate Questions** section on the main admin page (not inside the set editor). Fields: Set Name (autocompletes from existing sets), Difficulty, Count. If the set name matches an existing set, questions are added to it; otherwise a new set is created automatically.
