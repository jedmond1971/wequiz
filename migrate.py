#!/usr/bin/env python3
"""
Create database tables and optionally seed from data/questions.json.

Usage:
  python migrate.py          # create tables only
  python migrate.py --seed   # create tables + import questions.json
"""
import os
import sys
import json
import uuid

CREATE_SQL = """
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
"""


def seed_from_json(database_url, json_path='data/questions.json'):
    """Import question sets from a JSON file into the database.

    Skips any set whose ID already exists. Returns a dict with keys:
      imported_sets, skipped_sets, imported_questions.
    Raises FileNotFoundError if json_path does not exist.
    """
    if not os.path.exists(json_path):
        raise FileNotFoundError(f"{json_path} not found")

    with open(json_path) as f:
        data = json.load(f)

    sets = data.get('sets', [])
    imported_sets = skipped_sets = imported_questions = 0

    import psycopg2
    conn = psycopg2.connect(database_url)
    conn.autocommit = False
    cur = conn.cursor()
    try:
        for s in sets:
            cur.execute("SELECT id FROM question_sets WHERE id = %s", (s['id'],))
            if cur.fetchone():
                skipped_sets += 1
                continue

            cur.execute(
                "INSERT INTO question_sets (id, name) VALUES (%s, %s)",
                (s['id'], s['name'])
            )
            for pos, q in enumerate(s.get('questions', [])):
                q_id = q.get('id') or str(uuid.uuid4())
                cur.execute(
                    "INSERT INTO questions "
                    "(id, set_id, text, choices, correct, time_limit, position) "
                    "VALUES (%s, %s, %s, %s, %s, %s, %s)",
                    (q_id, s['id'], q['text'], json.dumps(q['choices']),
                     q['correct'], q.get('time_limit', 20), pos)
                )
                imported_questions += 1
            imported_sets += 1

        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()

    return {
        'imported_sets':     imported_sets,
        'skipped_sets':      skipped_sets,
        'imported_questions': imported_questions,
    }


def main():
    database_url = os.environ.get('DATABASE_URL')
    if not database_url:
        print("ERROR: DATABASE_URL is not set.")
        sys.exit(1)

    seed = '--seed' in sys.argv

    import psycopg2
    conn = psycopg2.connect(database_url)
    conn.autocommit = False
    cur = conn.cursor()
    print("Creating tables...")
    cur.execute(CREATE_SQL)
    conn.commit()
    cur.close()
    conn.close()
    print("Done.")

    json_path = 'data/questions.json'
    if not seed:
        if os.path.exists(json_path):
            print(f"\nFound {json_path}. Run with --seed to import it into the database.")
        return

    try:
        result = seed_from_json(database_url, json_path)
    except FileNotFoundError:
        print("No data/questions.json found — nothing to seed.")
        return

    print(
        f"\nResult: {result['imported_sets']} set(s) imported, "
        f"{result['skipped_sets']} skipped, "
        f"{result['imported_questions']} question(s) imported."
    )


if __name__ == '__main__':
    main()
