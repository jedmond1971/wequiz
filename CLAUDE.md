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

Push to `main` → Railway auto-deploys via `Procfile`. Set `ADMIN_PASSWORD` and `SECRET_KEY` env vars in Railway dashboard. The Procfile uses gunicorn with a single eventlet worker — **do not increase to multiple workers**, as game state is in-memory and not shared between processes.

## Architecture

Everything lives in `app.py`: Flask HTTP routes, REST API, and all SocketIO event handlers. No database — question sets persist in `data/questions.json`; active game rooms live in the `rooms = {}` dict in memory and are lost on restart.

### Game flow

1. Admin logs in → `/admin` (session cookie)
2. Admin clicks Launch on a set → `POST /api/start-game` → creates a room entry in `rooms`, returns a 6-char room code → redirects to `/host/<room_code>`
3. Host page opens a SocketIO connection (`host_connect`) and waits in lobby
4. Players go to `/play`, emit `player_join` with room code + nickname
5. Host emits `host_start_game` → server calls `_send_next_question(code)` in a loop
6. Each question: server emits `question_start` to the room, starts a background timer task via `socketio.start_background_task`; players submit via `submit_answer`; question ends either when all players answer (1.5s delay) or time expires
7. Server emits `show_leaderboard` → host advances → repeat until all questions done → `game_over`

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

- `admin.js` — SPA for managing question sets; holds full set state in a `sets` array in memory; writes to server on every change via `PUT /api/sets/<id>`
- `host.js` — manages host screen transitions (lobby → question → leaderboard → final); `ROOM_CODE` is injected as a global from the template
- `play.js` — manages player screen transitions; supports auto-join via `?code=X&nick=Y` URL params

### Timer

Client-side only (animated SVG ring, `r=36`, `circumference=226`). The server runs its own independent timer via `_question_timer` background task — the client timer is purely cosmetic. Color changes: white → amber at ≤10s → red at ≤5s.

### Sound effects

Both `host.js` and `play.js` contain a `SoundManager` IIFE at the top. All sounds are generated via Web Audio API (`AudioContext` + `OscillatorNode`) — no audio files.

- AudioContext is pre-warmed on the first user gesture (`click`/`touchstart`/`keydown`) so that socket-driven sounds don't hit the browser autoplay block.
- Mute state persists in `localStorage` under the key `wequiz_muted` (shared between host and player so the preference carries across screens).
- A mute toggle button (`🔊/🔇`) is rendered in both `host.html` and `play.html`.

**play.js sounds:** `questionDing` (question appears), `tapClick` (answer tapped), `correctChime` / `wrongBuzzer` (result), `tick` (countdown ≤5s).

**host.js sounds:** `playerJoin` (lobby), `gameStart` (start button), `questionReveal` (question live), `leaderboard` (results screen), `gameOver` (final screen).
