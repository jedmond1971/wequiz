import os
import json
import uuid
import time
import random
import string

from flask import Flask, render_template, request, redirect, url_for, session, jsonify
from flask_socketio import SocketIO, emit, join_room

app = Flask(__name__)
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'wequiz-secret-change-me')
socketio = SocketIO(app, cors_allowed_origins='*', async_mode='eventlet')

ADMIN_PASSWORD = os.environ.get('ADMIN_PASSWORD', 'admin123')
QUESTIONS_FILE = 'data/questions.json'

# In-memory game rooms: room_code -> room_state
rooms = {}


# ── Data helpers ──────────────────────────────────────────────────────────────

def load_data():
    if not os.path.exists(QUESTIONS_FILE):
        os.makedirs('data', exist_ok=True)
        _write_data({'sets': []})
    with open(QUESTIONS_FILE) as f:
        return json.load(f)


def _write_data(data):
    os.makedirs('data', exist_ok=True)
    with open(QUESTIONS_FILE, 'w') as f:
        json.dump(data, f, indent=2)


def gen_room_code():
    chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    while True:
        code = ''.join(random.choices(chars, k=6))
        if code not in rooms:
            return code


def get_leaderboard(room):
    return sorted(
        [{'nickname': p['nickname'], 'score': p['score']} for p in room['players'].values()],
        key=lambda x: x['score'],
        reverse=True,
    )


# ── HTTP routes ───────────────────────────────────────────────────────────────

@app.route('/')
def index():
    return render_template('index.html')


@app.route('/admin', methods=['GET', 'POST'])
def admin():
    if request.method == 'POST':
        if request.form.get('password') == ADMIN_PASSWORD:
            session['admin'] = True
            return redirect(url_for('admin'))
        return render_template('admin_login.html', error='Incorrect password — try again.')
    if not session.get('admin'):
        return render_template('admin_login.html')
    return render_template('admin.html')


@app.route('/admin/logout')
def admin_logout():
    session.pop('admin', None)
    return redirect(url_for('index'))


@app.route('/host/<room_code>')
def host_view(room_code):
    if not session.get('admin'):
        return redirect(url_for('admin'))
    if room_code not in rooms:
        return redirect(url_for('admin'))
    return render_template('host.html', room_code=room_code)


@app.route('/play')
def play():
    return render_template('play.html')


# ── API routes ────────────────────────────────────────────────────────────────

def require_admin():
    if not session.get('admin'):
        return jsonify({'error': 'Unauthorized'}), 401
    return None


@app.route('/api/sets', methods=['GET'])
def api_get_sets():
    if (err := require_admin()):
        return err
    return jsonify(load_data()['sets'])


@app.route('/api/sets', methods=['POST'])
def api_create_set():
    if (err := require_admin()):
        return err
    data = load_data()
    new_set = {
        'id': str(uuid.uuid4()),
        'name': (request.json or {}).get('name', 'Untitled Set'),
        'questions': [],
    }
    data['sets'].append(new_set)
    _write_data(data)
    return jsonify(new_set), 201


@app.route('/api/sets/<set_id>', methods=['PUT'])
def api_update_set(set_id):
    if (err := require_admin()):
        return err
    data = load_data()
    for s in data['sets']:
        if s['id'] == set_id:
            body = request.json or {}
            if 'name' in body:
                s['name'] = body['name']
            if 'questions' in body:
                s['questions'] = body['questions']
            _write_data(data)
            return jsonify(s)
    return jsonify({'error': 'Not found'}), 404


@app.route('/api/sets/<set_id>', methods=['DELETE'])
def api_delete_set(set_id):
    if (err := require_admin()):
        return err
    data = load_data()
    data['sets'] = [s for s in data['sets'] if s['id'] != set_id]
    _write_data(data)
    return jsonify({'ok': True})


@app.route('/api/start-game', methods=['POST'])
def api_start_game():
    if (err := require_admin()):
        return err
    set_id = (request.json or {}).get('set_id')
    data = load_data()
    qs = next((s for s in data['sets'] if s['id'] == set_id), None)
    if not qs:
        return jsonify({'error': 'Question set not found'}), 404
    if not qs.get('questions'):
        return jsonify({'error': 'Add at least one question before starting'}), 400

    code = gen_room_code()
    rooms[code] = {
        'host_sid': None,
        'question_set': qs,
        'questions': qs['questions'],
        'current_q': -1,
        'state': 'lobby',        # lobby | question | leaderboard | finished
        'players': {},           # sid -> {nickname, score}
        'q_start_time': None,
        'round_answers': {},     # sid -> {answer, correct, score}
    }
    return jsonify({'room_code': code})


# ── SocketIO events ───────────────────────────────────────────────────────────

@socketio.on('host_connect')
def on_host_connect(data):
    code = data.get('room_code', '').upper()
    if code not in rooms:
        emit('error', {'message': 'Room not found'})
        return
    rooms[code]['host_sid'] = request.sid
    join_room(code)
    join_room(f'host_{code}')
    room = rooms[code]
    emit('host_room_info', {
        'room_code': code,
        'set_name': room['question_set']['name'],
        'total_questions': len(room['questions']),
        'players': [p['nickname'] for p in room['players'].values()],
        'state': room['state'],
    })


@socketio.on('player_join')
def on_player_join(data):
    code = data.get('room_code', '').upper().strip()
    nick = data.get('nickname', '').strip()

    if not code or not nick:
        emit('join_error', {'message': 'Room code and nickname are required.'})
        return
    if len(nick) > 20:
        emit('join_error', {'message': 'Nickname must be 20 characters or less.'})
        return
    if code not in rooms:
        emit('join_error', {'message': 'Room not found — double-check your code!'})
        return

    room = rooms[code]
    if room['state'] != 'lobby':
        emit('join_error', {'message': 'Game is already in progress!'})
        return

    existing = [p['nickname'].lower() for p in room['players'].values()]
    if nick.lower() in existing:
        emit('join_error', {'message': 'That nickname is already taken!'})
        return

    room['players'][request.sid] = {'nickname': nick, 'score': 0}
    join_room(code)

    emit('join_success', {'nickname': nick, 'room_code': code})
    socketio.emit('player_joined', {
        'nickname': nick,
        'players': [p['nickname'] for p in room['players'].values()],
    }, to=f'host_{code}')


@socketio.on('host_start_game')
def on_host_start(data):
    code = data.get('room_code', '').upper()
    if code not in rooms:
        return
    room = rooms[code]
    if room['host_sid'] != request.sid:
        return
    if not room['players']:
        emit('error', {'message': 'No players have joined yet!'})
        return
    _send_next_question(code)


@socketio.on('host_next_question')
def on_host_next(data):
    code = data.get('room_code', '').upper()
    if code not in rooms:
        return
    if rooms[code]['host_sid'] != request.sid:
        return
    if rooms[code]['state'] == 'leaderboard':
        _send_next_question(code)


@socketio.on('host_end_question')
def on_host_end_question(data):
    code = data.get('room_code', '').upper()
    if code not in rooms:
        return
    if rooms[code]['host_sid'] != request.sid:
        return
    if rooms[code]['state'] == 'question':
        _end_question(code)


@socketio.on('submit_answer')
def on_submit_answer(data):
    code = data.get('room_code', '').upper()
    ans = data.get('answer')

    if code not in rooms:
        return
    room = rooms[code]
    if room['state'] != 'question':
        return
    if request.sid not in room['players']:
        return
    if request.sid in room['round_answers']:
        return  # already answered

    q = room['questions'][room['current_q']]
    correct = (ans == q['correct'])
    time_taken = time.time() - room['q_start_time']
    time_limit = q.get('time_limit', 20)

    # 500–1000 pts for correct, scaled by speed; 0 for wrong
    score = int(500 + 500 * max(0.0, 1.0 - time_taken / time_limit)) if correct else 0

    room['round_answers'][request.sid] = {'answer': ans, 'correct': correct, 'score': score}
    if correct:
        room['players'][request.sid]['score'] += score

    emit('answer_result', {
        'correct': correct,
        'score': score,
        'total_score': room['players'][request.sid]['score'],
    })
    socketio.emit('answer_count', {
        'answered': len(room['round_answers']),
        'total': len(room['players']),
    }, to=f'host_{code}')

    # Auto-end when everyone has answered
    if len(room['round_answers']) >= len(room['players']):
        socketio.start_background_task(_auto_end, code, room['current_q'])


@socketio.on('disconnect')
def on_disconnect():
    for code, room in list(rooms.items()):
        if request.sid in room['players']:
            player = room['players'].pop(request.sid)
            if room['state'] == 'lobby':
                socketio.emit('player_left', {
                    'nickname': player['nickname'],
                    'players': [p['nickname'] for p in room['players'].values()],
                }, to=f'host_{code}')
            break
        if room.get('host_sid') == request.sid:
            room['host_sid'] = None
            break


# ── Game logic ────────────────────────────────────────────────────────────────

def _send_next_question(code):
    room = rooms[code]
    room['current_q'] += 1

    if room['current_q'] >= len(room['questions']):
        _finish_game(code)
        return

    room['state'] = 'question'
    room['round_answers'] = {}
    room['q_start_time'] = time.time()

    q = room['questions'][room['current_q']]
    time_limit = q.get('time_limit', 20)

    socketio.emit('question_start', {
        'question': q['text'],
        'choices': q['choices'],
        'time_limit': time_limit,
        'q_num': room['current_q'] + 1,
        'total': len(room['questions']),
    }, to=code)

    socketio.start_background_task(_question_timer, code, room['current_q'], time_limit)


def _question_timer(code, q_idx, time_limit):
    socketio.sleep(time_limit)
    if code not in rooms:
        return
    room = rooms[code]
    if room['current_q'] == q_idx and room['state'] == 'question':
        _end_question(code)


def _auto_end(code, q_idx):
    socketio.sleep(1.5)  # brief pause so last player sees their result
    if code not in rooms:
        return
    room = rooms[code]
    if room['current_q'] == q_idx and room['state'] == 'question':
        _end_question(code)


def _end_question(code):
    room = rooms[code]
    if room['state'] != 'question':
        return
    room['state'] = 'leaderboard'
    q = room['questions'][room['current_q']]
    is_last = room['current_q'] >= len(room['questions']) - 1
    socketio.emit('show_leaderboard', {
        'leaderboard': get_leaderboard(room),
        'correct_answer': q['correct'],
        'correct_text': q['choices'][q['correct']],
        'is_last': is_last,
    }, to=code)


def _finish_game(code):
    room = rooms[code]
    room['state'] = 'finished'
    socketio.emit('game_over', {
        'leaderboard': get_leaderboard(room),
    }, to=code)


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    socketio.run(app, host='0.0.0.0', port=port, debug=True)
