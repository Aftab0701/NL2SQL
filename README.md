# NL2SQL
# Query Desk — Natural Language to SQL Engine

Type a question in plain English, see the SQL it turns into, and run it against a real
seeded SQLite database — all in one page.

![status](https://img.shields.io/badge/status-working-brightgreen)

## Quick start

```bash
# 1. Clone / unzip, then from the project root:
python3 -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate

# 2. Install dependencies
pip install -r requirements.txt

# 3. Create + seed the database (5 tables, 300+ rows total, run once)
python3 -m backend.seed

# 4. (Optional but recommended) enable full LLM-based NL→SQL
cp .env.example .env
# then edit .env and set ANTHROPIC_API_KEY=sk-ant-...
# Without a key, the app still works end-to-end via a rule-based fallback
# that covers the example prompts below.

# 5. Run the server
uvicorn backend.app:app --reload --port 8000
```

Open **http://localhost:8000** in your browser. That's it — one process serves both
the API and the frontend.

Re-running `python3 -m backend.seed` at any point drops and recreates all tables with
fresh sample data (deterministic, seeded with a fixed random seed so results are
reproducible run to run).

## Try these

- `List all customers`
- `Show me all orders placed in the last 30 days`
- `How many products are out of stock?`
- `Find the top 5 customers by total spend`
- `Show all employees in the Engineering department hired after 2022`
- `Delete all customers from Mumbai` → blocked, since it's a write request
- `hi` → blocked, too short to act on

## Technologies used, and why

| Piece | Choice | Why |
|---|---|---|
| Backend | **FastAPI** + Uvicorn | Small, typed, async-friendly; trivial to expose a couple of JSON endpoints without boilerplate |
| Database | **SQLite** | Zero install, single file, ships with Python — reviewer can run this in seconds with no external DB server |
| NL → SQL | **Claude API** (`anthropic` SDK), schema-grounded prompt | The schema is read live from the DB (not hardcoded into the prompt), so the model always sees the real tables/columns |
| Fallback | Rule-based regex matcher | Keeps the product fully demoable with zero configuration, and gives every safety/edge-case path something deterministic to test against |
| Frontend | Plain HTML/CSS/JS (no framework) | The whole UI is one form → one SQL panel → one table; a framework would add build tooling for no real benefit here |

## Database schema, and why

An e-commerce schema with a small HR slice bolted on, because the brief's own example
prompts span both worlds ("top customers by spend" *and* "employees in Engineering
hired after 2022"):

```
customers (customer_id PK, name, email, city, country, created_at)
products  (product_id PK, name, category, price, stock_quantity)
orders    (order_id PK, customer_id FK → customers, order_date, status, order_total)
order_items (order_item_id PK, order_id FK → orders, product_id FK → products, quantity, unit_price)
employees (employee_id PK, name, department, title, hire_date, salary)
```

- `orders` → `customers` and `order_items` → `orders`/`products` give real join paths
  (needed for "top 5 customers by total spend", which requires a `JOIN` + `GROUP BY`).
- `order_total` is stored denormalized on `orders` (in addition to being derivable from
  `order_items`) to keep the "top spender" example query a simple aggregate rather than
  a nested subquery — a deliberate trade-off documented below.
- `employees` is a separate, unrelated table so the interface has to handle two
  genuinely different domains in one schema, exercising the "does the model pick the
  right table" case rather than always joining the same handful of tables.
- Seed data: 60 customers, 60 products, 90 orders, ~224 order line items, 55 employees
  (`python3 -m backend.seed`) — all with realistic names, cities, categories, and dates
  spread across 2021–2026, generated with a fixed random seed for reproducibility.

## How each part of the brief is implemented

- **NL input** — a single textarea plus example chips for the prompts in the brief.
- **SQL generation & display** — `backend/nl2sql.py` builds a system prompt from the
  *live* schema, asks Claude for one `SELECT`/`WITH` statement, and the frontend
  reveals it with a typewriter animation before running it. The SQL box is editable
  (`Edit` → change the text → `Run edited query`), and edits go through the exact
  same safety gate as generated SQL (`/api/execute`).
- **Execution** — `backend/database.py` opens the SQLite file in **read-only mode**
  (`file:...?mode=ro`) for every user-triggered query, on top of the keyword/AST-level
  guard in `nl2sql.validate_sql`. Two independent layers have to agree before anything
  runs.
- **Results table** — dynamic columns from `cursor.description`, a row-count indicator,
  client-side pagination (20 rows/page) over a scrollable container, `null` values
  rendered distinctly.
- **Query history** — kept client-side for the current browser session (per the
  brief's "current session" wording); clicking an entry restores the question, SQL,
  and results instantly without re-querying the server.
- **Edge cases**:
  - Ambiguous prompt → best-effort SQL, and the SQL panel *is* the disclosure of how
    it was interpreted.
  - Missing table/column → `sqlite3.OperationalError` is caught and translated into a
    plain-English message (`backend/app.py::_human_readable_db_error`), never a raw
    traceback.
  - Zero rows → distinct "ran successfully, no results" message, not treated as an error.
  - Mutation intent (`INSERT`/`UPDATE`/`DELETE`/`DROP`/...) → checked both on the raw
    NL text and on the generated/edited SQL; blocked before the database is touched.
  - Empty/too-short input → blocked client-side and server-side with a prompt to add
    detail.

## Bonus features implemented

- **Editable SQL before execution** ✅ (`Edit` toggle → `Run edited query`)
- **Query result export** ✅ (`Export CSV` button, client-side, no extra round trip)
- **Schema explorer** ✅ (sidebar, pulled live from `PRAGMA table_info`, not hardcoded)
- **Query speed & caching (written section)** — see below.

### Query speed and caching (≤200 words)

I'd add a two-layer cache keyed on the *validated SQL string* (not the raw English,
since two different phrasings can generate identical SQL and should share a cache
entry). Layer one: an in-process LRU cache (e.g. `functools.lru_cache` or a small
dict with TTL) for the hot path — sub-millisecond hits, cleared on deploy. Layer two:
Redis with a short TTL (30–60s) shared across worker processes, so a burst of
identical dashboard queries only reaches SQLite once. Cache invalidation is the real
risk: SQLite has no built-in change notification, so on every write path (there are
none from users here, but an admin/ETL job would have one) I'd bump a monotonic
`schema_version`/`data_version` counter and fold it into the cache key, which
invalidates everything cheaply without tracking per-table dependencies. Trade-off:
this can serve slightly stale reads for the TTL window — acceptable for an analytics
tool, not for anything transactional. For the NL→SQL generation step specifically
(the more expensive LLM call), I'd cache on the *question text* itself with a longer
TTL, since identical English almost always should produce identical SQL.

## Deploying to Netlify (Frontend)

To deploy this application to Netlify:

1. Push this repository to GitHub/GitLab/Bitbucket.
2. Create a new site on Netlify and link the repository.
3. The included `netlify.toml` automatically configures the **publish directory** to `frontend`.
4. Netlify will deploy the static frontend seamlessly.
5. **Important**: Since the backend is written in Python (FastAPI), it cannot run natively on Netlify. You must deploy the backend to a service like **Render**, **Railway**, or **Fly.io**. 
6. Once your backend is deployed, update the `[[redirects]]` section in the `netlify.toml` to point to your new live backend URL (replace `https://your-backend-url.onrender.com`). Netlify will act as a reverse proxy, avoiding any CORS issues!

## Assumptions & trade-offs

- The brief's "users" example table doesn't exist in an e-commerce schema, so
  `List all users` maps to the closest real analogue, `customers` — the SQL panel
  makes this interpretation visible rather than silently guessing.
- Query history is per-browser-session (in memory), not persisted server-side, since
  the brief scopes it to "the current session."
- Results are capped at 1000 rows server-side as a safety limit against a runaway
  `SELECT *`; the UI flags when a result set was truncated.
- The rule-based fallback intentionally only covers the brief's example phrasing
  families — it exists to keep the app runnable with zero API key, not to replace
  the LLM path.
