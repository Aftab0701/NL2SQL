"""
database.py
Handles the SQLite connection and safe, read-only query execution.

Design notes:
- The database is opened in read-only mode via a `file:...?mode=ro` URI whenever
  we execute a *user-generated* query. This is a second, independent layer of
  protection on top of the keyword/AST checks in nl2sql.py -- even if a
  malicious or buggy SQL string slipped past the text-based guard, SQLite
  itself will refuse to write to a read-only-mode connection.
- Seeding/schema creation uses a normal writable connection.
"""

import os
import sqlite3
from contextlib import contextmanager

DB_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "nl2sql.db")
os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)


def get_writable_connection() -> sqlite3.Connection:
    """Used only by seed.py to create/populate tables."""
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA foreign_keys = ON;")
    return conn


@contextmanager
def get_readonly_connection():
    """
    Opens the database strictly read-only. Any attempted write raises
    sqlite3.OperationalError('attempt to write a readonly database').
    """
    if not os.path.exists(DB_PATH):
        raise FileNotFoundError(
            "Database not found. Run `python backend/seed.py` first to create and seed it."
        )
    uri = f"file:{DB_PATH}?mode=ro"
    conn = sqlite3.connect(uri, uri=True)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()


def get_schema_snapshot() -> dict:
    """Returns {table_name: [ {name, type} ... ]} for the schema explorer + prompt building."""
    schema = {}
    with get_readonly_connection() as conn:
        tables = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;"
        ).fetchall()
        for t in tables:
            table_name = t["name"]
            cols = conn.execute(f"PRAGMA table_info('{table_name}');").fetchall()
            schema[table_name] = [{"name": c["name"], "type": c["type"]} for c in cols]
    return schema
