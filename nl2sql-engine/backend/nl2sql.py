"""
nl2sql.py
Turns a plain-English question into a single, safe, read-only SQL query.

Two-tier strategy:
  1. If ANTHROPIC_API_KEY is set, ask Claude to write the query, grounded in the
     real schema (tables + columns pulled live from the database, not hardcoded).
  2. Otherwise (or if the API call fails for any reason), fall back to a small
     rule-based matcher that covers the example prompts from the brief and a
     handful of common patterns. This keeps the product demoable with zero
     configuration, and gives the LLM path something sane to be compared against.

Either way, every candidate query passes through `validate_sql` before it is
ever handed to the executor. This is the single choke point that enforces
"read-only, one statement, no unknown intent."
"""

import os
import re
import json

from .database import get_schema_snapshot

try:
    import anthropic
except ImportError:
    anthropic = None

MODEL = os.environ.get("NL2SQL_MODEL", "claude-sonnet-5")

# Keywords that must never appear in an executable query.
FORBIDDEN_KEYWORDS = re.compile(
    r"\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|REPLACE|ATTACH|DETACH|PRAGMA|VACUUM|GRANT|REVOKE)\b",
    re.IGNORECASE,
)


class MutationBlockedError(Exception):
    """Raised when the user's request (or the generated SQL) implies a write operation."""


class SQLValidationError(Exception):
    """Raised when the generated SQL fails safety checks for reasons other than mutation intent."""


def _looks_like_mutation_request(question: str) -> bool:
    q = question.lower()
    mutation_words = ["insert", "update", "delete", "remove", "drop", "truncate", "create table",
                       "alter table", "modify the", "change the price", "set the", "add a row",
                       "delete all", "erase"]
    return any(w in q for w in mutation_words)


def validate_sql(sql: str) -> str:
    """
    Cleans and validates a candidate SQL string. Returns the cleaned single
    statement on success, or raises MutationBlockedError / SQLValidationError.
    """
    cleaned = sql.strip()
    if cleaned.endswith(";"):
        cleaned = cleaned[:-1].strip()

    if not cleaned:
        raise SQLValidationError("The model did not return a query.")

    # Reject multiple statements (stacked queries).
    if ";" in cleaned:
        raise SQLValidationError("Only a single query statement is allowed.")

    if FORBIDDEN_KEYWORDS.search(cleaned):
        raise MutationBlockedError(
            "This request looks like it would modify the database (insert, update, delete, "
            "or similar). Only read (SELECT) queries are permitted here."
        )

    first_word = cleaned.strip().split(None, 1)[0].upper()
    if first_word not in ("SELECT", "WITH"):
        raise SQLValidationError(
            f"Generated a '{first_word}' statement, but only SELECT queries are supported."
        )

    return cleaned + ";"


def _build_schema_prompt(schema: dict) -> str:
    lines = []
    for table, cols in schema.items():
        col_desc = ", ".join(f"{c['name']} ({c['type']})" for c in cols)
        lines.append(f"- {table}({col_desc})")
    return "\n".join(lines)


SYSTEM_PROMPT_TEMPLATE = """You are a SQL generation engine for a SQLite database. \
Given a natural language question, output ONLY the SQL query that answers it -- no \
explanation, no markdown fences, no commentary. Always produce exactly one statement.

Database schema:
{schema}

Rules:
- Only ever produce a single SELECT (or WITH ... SELECT) statement. Never produce \
INSERT, UPDATE, DELETE, DROP, ALTER, or any other write statement, even if asked.
- Use only the tables and columns listed above. Do not invent columns.
- Prefer explicit column lists over SELECT * when the question implies specific fields, \
but SELECT * is fine for simple "list all X" requests.
- For relative dates like "last 30 days", use SQLite date functions relative to \
date('now') -- e.g. date('now', '-30 days').
- If the question is ambiguous, make the most reasonable interpretation and answer that \
interpretation -- do not ask a clarifying question, since your only output channel is SQL.
- Return raw SQL text only.
"""


def generate_sql_via_llm(question: str, schema: dict) -> str:
    if anthropic is None:
        raise RuntimeError("anthropic package not installed")
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise RuntimeError("ANTHROPIC_API_KEY not set")

    client = anthropic.Anthropic(api_key=api_key)
    system_prompt = SYSTEM_PROMPT_TEMPLATE.format(schema=_build_schema_prompt(schema))

    response = client.messages.create(
        model=MODEL,
        max_tokens=500,
        system=system_prompt,
        messages=[{"role": "user", "content": question}],
    )
    text_parts = [block.text for block in response.content if getattr(block, "type", None) == "text"]
    raw = "".join(text_parts).strip()

    # Strip markdown fences if the model added them anyway.
    raw = re.sub(r"^```(sql)?", "", raw.strip(), flags=re.IGNORECASE).strip()
    raw = re.sub(r"```$", "", raw.strip()).strip()
    return raw


# ---------------------------------------------------------------------------
# Rule-based fallback: covers the brief's example prompts + common variants.
# Used automatically when no API key is configured or the LLM call errors out.
# ---------------------------------------------------------------------------

def generate_sql_via_rules(question: str) -> str:
    q = question.lower().strip()

    if re.search(r"\ball users\b|\blist.*users\b", q):
        # No literal "users" table in this schema -- closest analogue is customers.
        return "SELECT * FROM customers;"

    if "out of stock" in q or ("how many products" in q and "stock" in q):
        return "SELECT COUNT(*) AS out_of_stock_count FROM products WHERE stock_quantity = 0;"

    m = re.search(r"orders?.*last\s+(\d+)\s+days", q)
    if m:
        days = int(m.group(1))
        return (
            "SELECT order_id, customer_id, order_date, status, order_total "
            f"FROM orders WHERE order_date >= date('now', '-{days} days') ORDER BY order_date DESC;"
        )

    m = re.search(r"top\s+(\d+)\s+customers?.*spend", q)
    if m:
        n = int(m.group(1))
        return (
            "SELECT c.customer_id, c.name, SUM(o.order_total) AS total_spend "
            "FROM orders o JOIN customers c ON o.customer_id = c.customer_id "
            f"GROUP BY c.customer_id, c.name ORDER BY total_spend DESC LIMIT {n};"
        )

    m = re.search(r"employees?.*(engineering|sales|marketing|hr|finance|customer support|product|design)", q)
    if m:
        dept = m.group(1)
        dept_title = "Customer Support" if dept == "customer support" else dept.title()
        year_m = re.search(r"hired after (\d{4})", q) or re.search(r"after (\d{4})", q)
        if year_m:
            year = year_m.group(1)
            return (
                "SELECT employee_id, name, department, title, hire_date, salary FROM employees "
                f"WHERE department = '{dept_title}' AND hire_date > '{year}-12-31' ORDER BY hire_date;"
            )
        return (
            "SELECT employee_id, name, department, title, hire_date, salary FROM employees "
            f"WHERE department = '{dept_title}' ORDER BY hire_date;"
        )

    if "all employees" in q or ("list" in q and "employees" in q):
        return "SELECT * FROM employees;"

    if "all products" in q or ("list" in q and "products" in q):
        return "SELECT * FROM products;"

    if "all customers" in q or ("list" in q and "customers" in q):
        return "SELECT * FROM customers;"

    if "all orders" in q or ("list" in q and "orders" in q):
        return "SELECT * FROM orders;"

    if "how many customers" in q:
        return "SELECT COUNT(*) AS customer_count FROM customers;"

    if "how many orders" in q:
        return "SELECT COUNT(*) AS order_count FROM orders;"

    if "average order" in q or "average spend" in q:
        return "SELECT AVG(order_total) AS average_order_total FROM orders;"

    if "cancelled orders" in q or "canceled orders" in q:
        return "SELECT * FROM orders WHERE status = 'cancelled';"

    # Last-resort generic fallback: surface the ambiguity in the query itself
    # rather than guessing wildly, so the user can see exactly what happened.
    raise SQLValidationError(
        "Couldn't confidently translate this request without an LLM connected. "
        "Try rephrasing, or set ANTHROPIC_API_KEY for full natural-language coverage."
    )


def generate_sql(question: str) -> dict:
    """
    Main entry point. Returns {"sql": str, "source": "llm"|"rules"} on success.
    Raises MutationBlockedError or SQLValidationError on failure -- callers
    should catch these and turn them into user-facing messages.
    """
    if not question or len(question.strip()) < 4:
        raise SQLValidationError("Please describe the data you need in a bit more detail.")

    if _looks_like_mutation_request(question):
        raise MutationBlockedError(
            "This looks like a request to change data (insert, update, delete, etc). "
            "Only read (SELECT) queries are permitted here."
        )

    schema = get_schema_snapshot()

    source = "llm"
    try:
        raw_sql = generate_sql_via_llm(question, schema)
        if not raw_sql:
            raise RuntimeError("empty LLM response")
    except Exception:
        source = "rules"
        raw_sql = generate_sql_via_rules(question)

    validated = validate_sql(raw_sql)
    return {"sql": validated, "source": source}
