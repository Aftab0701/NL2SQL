"""
app.py
FastAPI server exposing:
  POST /api/query   -> generate SQL from natural language, execute it, return results
  GET  /api/schema   -> table/column list for the schema explorer
  GET  /             -> the frontend (static files)

Run with:  uvicorn backend.app:app --reload --port 8000   (from the project root)
"""

import os
import sqlite3
import time

from dotenv import load_dotenv

load_dotenv()

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel

from .database import get_readonly_connection, get_schema_snapshot
from .nl2sql import generate_sql, validate_sql, MutationBlockedError, SQLValidationError

app = FastAPI(title="NL to SQL Engine")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

FRONTEND_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "frontend")

MAX_ROWS = 1000  # sane cap so a runaway SELECT can't blow up the response


class QueryRequest(BaseModel):
    question: str


class ExecuteRequest(BaseModel):
    sql: str


def _execute_sql(sql: str):
    """Shared executor used by both /api/query and /api/execute."""
    start = time.time()
    try:
        with get_readonly_connection() as conn:
            cursor = conn.execute(sql)
            columns = [d[0] for d in cursor.description] if cursor.description else []
            rows = cursor.fetchmany(MAX_ROWS)
            rows = [dict(row) for row in rows]
    except sqlite3.Error as e:
        return {"ok": False, "stage": "execution", "sql": sql, "error": _human_readable_db_error(e)}
    except FileNotFoundError as e:
        return {"ok": False, "stage": "execution", "sql": sql, "error": str(e)}

    elapsed_ms = round((time.time() - start) * 1000, 1)
    return {
        "ok": True,
        "sql": sql,
        "columns": columns,
        "rows": rows,
        "row_count": len(rows),
        "truncated": len(rows) == MAX_ROWS,
        "elapsed_ms": elapsed_ms,
    }


def _human_readable_db_error(exc: Exception) -> str:
    msg = str(exc)
    if "no such table" in msg:
        table = msg.split("no such table:")[-1].strip()
        return f"The generated query refers to a table (\"{table}\") that doesn't exist in this database."
    if "no such column" in msg:
        col = msg.split("no such column:")[-1].strip()
        return f"The generated query refers to a column (\"{col}\") that doesn't exist in this database."
    if "readonly database" in msg or "read-only" in msg:
        return "That query attempted to modify the database, which isn't permitted here."
    if "syntax error" in msg:
        return "The generated SQL had a syntax error and could not be run."
    return "The query could not be run against the database. Please try rephrasing your request."


@app.post("/api/query")
def run_query(req: QueryRequest):
    question = (req.question or "").strip()

    if len(question) < 4:
        return {
            "ok": False,
            "stage": "input",
            "error": "Please describe the data you need — that request looks too short to work with.",
        }

    try:
        gen = generate_sql(question)
    except MutationBlockedError as e:
        return {"ok": False, "stage": "blocked", "error": str(e)}
    except SQLValidationError as e:
        return {"ok": False, "stage": "generation", "error": str(e)}
    except Exception as e:
        return {"ok": False, "stage": "generation", "error": f"Couldn't generate a query for that: {e}"}

    sql = gen["sql"]
    result = _execute_sql(sql)
    result["source"] = gen["source"]
    return result


@app.post("/api/execute")
def execute_edited_query(req: ExecuteRequest):
    """Runs a user-edited SQL string through the same safety gate as generated SQL."""
    try:
        validated = validate_sql(req.sql)
    except MutationBlockedError as e:
        return {"ok": False, "stage": "blocked", "error": str(e)}
    except SQLValidationError as e:
        return {"ok": False, "stage": "generation", "error": str(e)}

    result = _execute_sql(validated)
    result["source"] = "edited"
    return result


@app.get("/api/schema")
def schema():
    try:
        return {"ok": True, "schema": get_schema_snapshot()}
    except FileNotFoundError as e:
        return {"ok": False, "error": str(e)}


# --- static frontend ---
app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")


@app.get("/")
def index():
    return FileResponse(os.path.join(FRONTEND_DIR, "index.html"))
