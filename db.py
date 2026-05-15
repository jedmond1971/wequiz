import os
import json
import uuid
import random
import contextlib
from itertools import groupby

DATABASE_URL = os.environ.get('DATABASE_URL', '')
USE_DB = bool(DATABASE_URL)

if USE_DB:
    import psycopg2
    from psycopg2.extras import RealDictCursor


@contextlib.contextmanager
def _conn():
    conn = psycopg2.connect(DATABASE_URL)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_schema():
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS question_sets (
                    id   TEXT PRIMARY KEY,
                    name TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS questions (
                    id         TEXT PRIMARY KEY,
                    set_id     TEXT NOT NULL REFERENCES question_sets(id) ON DELETE CASCADE,
                    text       TEXT NOT NULL,
                    choices    JSONB NOT NULL,
                    correct    INTEGER NOT NULL DEFAULT 0,
                    time_limit INTEGER NOT NULL DEFAULT 20,
                    position   INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS game_sessions (
                    id        TEXT PRIMARY KEY,
                    set_id    TEXT NOT NULL,
                    room_code TEXT NOT NULL,
                    played_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );
                CREATE TABLE IF NOT EXISTS session_questions (
                    session_id  TEXT NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
                    question_id TEXT NOT NULL,
                    PRIMARY KEY (session_id, question_id)
                );
            """)


# ── Row helpers ────────────────────────────────────────────────────────────────

def _q_row(row):
    choices = row['choices']
    if isinstance(choices, str):
        choices = json.loads(choices)
    return {
        'id':         row['id'],
        'text':       row['text'],
        'choices':    choices,
        'correct':    row['correct'],
        'time_limit': row['time_limit'],
    }


def _set_row(s, questions):
    return {'id': s['id'], 'name': s['name'], 'questions': questions}


# ── CRUD ───────────────────────────────────────────────────────────────────────

def db_get_all_sets():
    with _conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT id, name FROM question_sets ORDER BY name")
            sets = cur.fetchall()
            result = []
            for s in sets:
                cur.execute(
                    "SELECT id, text, choices, correct, time_limit "
                    "FROM questions WHERE set_id = %s ORDER BY position",
                    (s['id'],)
                )
                result.append(_set_row(s, [_q_row(q) for q in cur.fetchall()]))
            return result


def db_create_set(name):
    new_id = str(uuid.uuid4())
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute("INSERT INTO question_sets (id, name) VALUES (%s, %s)", (new_id, name))
    return {'id': new_id, 'name': name, 'questions': []}


def db_get_set(set_id):
    with _conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT id, name FROM question_sets WHERE id = %s", (set_id,))
            s = cur.fetchone()
            if not s:
                return None
            cur.execute(
                "SELECT id, text, choices, correct, time_limit "
                "FROM questions WHERE set_id = %s ORDER BY position",
                (set_id,)
            )
            return _set_row(s, [_q_row(q) for q in cur.fetchall()])


def db_update_set(set_id, body):
    with _conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT id, name FROM question_sets WHERE id = %s", (set_id,))
            s = cur.fetchone()
            if not s:
                return None
            s = dict(s)

            if 'name' in body:
                cur.execute(
                    "UPDATE question_sets SET name = %s WHERE id = %s",
                    (body['name'], set_id)
                )
                s['name'] = body['name']

            if 'questions' in body:
                cur.execute("SELECT id FROM questions WHERE set_id = %s", (set_id,))
                existing_ids = {r['id'] for r in cur.fetchall()}

                incoming_ids = set()
                for pos, q in enumerate(body['questions']):
                    q_id = q.get('id') or ''
                    if q_id in existing_ids:
                        cur.execute(
                            "UPDATE questions "
                            "SET text=%s, choices=%s, correct=%s, time_limit=%s, position=%s "
                            "WHERE id = %s",
                            (q['text'], json.dumps(q['choices']), q['correct'],
                             q.get('time_limit', 20), pos, q_id)
                        )
                    else:
                        if not q_id:
                            q_id = str(uuid.uuid4())
                        cur.execute(
                            "INSERT INTO questions "
                            "(id, set_id, text, choices, correct, time_limit, position) "
                            "VALUES (%s, %s, %s, %s, %s, %s, %s)",
                            (q_id, set_id, q['text'], json.dumps(q['choices']),
                             q['correct'], q.get('time_limit', 20), pos)
                        )
                    incoming_ids.add(q_id)

                for stale_id in existing_ids - incoming_ids:
                    cur.execute("DELETE FROM questions WHERE id = %s", (stale_id,))

            cur.execute(
                "SELECT id, text, choices, correct, time_limit "
                "FROM questions WHERE set_id = %s ORDER BY position",
                (set_id,)
            )
            return _set_row(s, [_q_row(q) for q in cur.fetchall()])


def db_delete_set(set_id):
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM question_sets WHERE id = %s", (set_id,))
            return cur.rowcount > 0


# ── Rotation ───────────────────────────────────────────────────────────────────

def db_get_questions_for_game(set_id):
    """Return all questions for a set ordered so least-recently-used come first.

    Questions never played come before any that have been played. Within ties
    (same last_used timestamp or both NULL) the order is randomised.
    """
    with _conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("""
                SELECT q.id, q.text, q.choices, q.correct, q.time_limit,
                       MAX(gs.played_at) AS last_used
                FROM questions q
                LEFT JOIN session_questions sq ON sq.question_id = q.id
                LEFT JOIN game_sessions gs     ON gs.id = sq.session_id
                WHERE q.set_id = %s
                GROUP BY q.id, q.text, q.choices, q.correct, q.time_limit
                ORDER BY last_used ASC NULLS FIRST
            """, (set_id,))
            rows = cur.fetchall()

    result = []
    for _, group in groupby(rows, key=lambda r: r['last_used']):
        chunk = list(group)
        random.shuffle(chunk)
        result.extend(chunk)
    return [_q_row(r) for r in result]


# ── Session recording ──────────────────────────────────────────────────────────

def db_record_session(set_id, room_code, question_ids):
    session_id = str(uuid.uuid4())
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO game_sessions (id, set_id, room_code) VALUES (%s, %s, %s)",
                (session_id, set_id, room_code)
            )
            for q_id in question_ids:
                cur.execute(
                    "INSERT INTO session_questions (session_id, question_id) VALUES (%s, %s)",
                    (session_id, q_id)
                )
    return session_id
