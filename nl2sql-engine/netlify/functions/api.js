require('dotenv').config();
const express = require('express');
const serverless = require('serverless-http');
const Database = require('better-sqlite3');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');

const app = express();
app.use(express.json());

// Adjust path because Netlify might bundle it differently, but usually it keeps structure
// if we use included_files in netlify.toml
let DB_PATH = path.join(__dirname, '..', '..', 'data', 'nl2sql.db');
// If running locally vs netlify environment path adjustments:
if (!fs.existsSync(DB_PATH) && fs.existsSync(path.join(__dirname, '..', 'data', 'nl2sql.db'))) {
    DB_PATH = path.join(__dirname, '..', 'data', 'nl2sql.db');
} else if (!fs.existsSync(DB_PATH) && fs.existsSync('/var/task/data/nl2sql.db')) {
    DB_PATH = '/var/task/data/nl2sql.db'; // common AWS Lambda path
}

const MODEL = process.env.NL2SQL_MODEL || 'gemini-2.5-flash';
const MAX_ROWS = 1000;
const FORBIDDEN_KEYWORDS = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|REPLACE|ATTACH|DETACH|PRAGMA|VACUUM|GRANT|REVOKE)\b/i;

function getReadonlyConnection() {
    if (!fs.existsSync(DB_PATH)) {
        throw new Error("Database not found. Run `npm run seed` first to create and seed it.");
    }
    // better-sqlite3 readonly mode
    const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    return db;
}

function getSchemaSnapshot() {
    const db = getReadonlyConnection();
    const schema = {};
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;").all();
    
    for (const t of tables) {
        const cols = db.prepare(`PRAGMA table_info('${t.name}');`).all();
        schema[t.name] = cols.map(c => ({ name: c.name, type: c.type }));
    }
    db.close();
    return schema;
}

function _looks_like_mutation_request(question) {
    const q = question.toLowerCase();
    const mutationWords = ["insert", "update", "delete", "remove", "drop", "truncate", "create table",
                           "alter table", "modify the", "change the price", "set the", "add a row",
                           "delete all", "erase"];
    return mutationWords.some(w => q.includes(w));
}

function validateSql(sql) {
    let cleaned = sql.trim();
    if (cleaned.endsWith(';')) cleaned = cleaned.slice(0, -1).trim();
    if (!cleaned) throw new Error("VALIDATION_ERROR: The model did not return a query.");
    if (cleaned.includes(';')) throw new Error("VALIDATION_ERROR: Only a single query statement is allowed.");
    if (FORBIDDEN_KEYWORDS.test(cleaned)) {
        throw new Error("BLOCKED_ERROR: This request looks like it would modify the database (insert, update, delete, or similar). Only read (SELECT) queries are permitted here.");
    }
    const firstWord = cleaned.split(/\s+/)[0].toUpperCase();
    if (firstWord !== "SELECT" && firstWord !== "WITH") {
        throw new Error(`VALIDATION_ERROR: Generated a '${firstWord}' statement, but only SELECT queries are supported.`);
    }
    return cleaned + ";";
}

function _buildSchemaPrompt(schema) {
    let lines = [];
    for (const [table, cols] of Object.entries(schema)) {
        const colDesc = cols.map(c => `${c.name} (${c.type})`).join(", ");
        lines.push(`- ${table}(${colDesc})`);
    }
    return lines.join("\n");
}

const SYSTEM_PROMPT_TEMPLATE = `You are a SQL generation engine for a SQLite database. Given a natural language question, output ONLY the SQL query that answers it -- no explanation, no markdown fences, no commentary. Always produce exactly one statement.

Database schema:
{schema}

Rules:
- Only ever produce a single SELECT (or WITH ... SELECT) statement. Never produce INSERT, UPDATE, DELETE, DROP, ALTER, or any other write statement, even if asked.
- Use only the tables and columns listed above. Do not invent columns.
- Prefer explicit column lists over SELECT * when the question implies specific fields, but SELECT * is fine for simple "list all X" requests.
- For relative dates like "last 30 days", use SQLite date functions relative to date('now') -- e.g. date('now', '-30 days').
- If the question is ambiguous, make the most reasonable interpretation and answer that interpretation -- do not ask a clarifying question, since your only output channel is SQL.
- Return raw SQL text only.`;

async function generateSqlViaLlm(question, schema) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY not set");

    const genAI = new GoogleGenerativeAI(apiKey);
    const systemPrompt = SYSTEM_PROMPT_TEMPLATE.replace("{schema}", _buildSchemaPrompt(schema));
    
    const model = genAI.getGenerativeModel({
        model: MODEL,
        systemInstruction: systemPrompt
    });

    const result = await model.generateContent(question);
    const response = await result.response;
    
    let raw = (response.text() || "").trim();
    raw = raw.replace(/^```(sql)?/i, "").trim();
    raw = raw.replace(/```$/, "").trim();
    return raw;
}

function generateSqlViaRules(question) {
    const q = question.toLowerCase().trim();

    if (/\ball users\b|\blist.*users\b/.test(q)) return "SELECT * FROM customers;";
    if (q.includes("out of stock") || (q.includes("how many products") && q.includes("stock"))) {
        return "SELECT COUNT(*) AS out_of_stock_count FROM products WHERE stock_quantity = 0;";
    }
    let m = q.match(/orders?.*last\s+(\d+)\s+days/);
    if (m) return `SELECT order_id, customer_id, order_date, status, order_total FROM orders WHERE order_date >= date('now', '-${m[1]} days') ORDER BY order_date DESC;`;

    m = q.match(/top\s+(\d+)\s+customers?.*spend/);
    if (m) return `SELECT c.customer_id, c.name, SUM(o.order_total) AS total_spend FROM orders o JOIN customers c ON o.customer_id = c.customer_id GROUP BY c.customer_id, c.name ORDER BY total_spend DESC LIMIT ${m[1]};`;

    m = q.match(/employees?.*(engineering|sales|marketing|hr|finance|customer support|product|design)/);
    if (m) {
        let dept = m[1];
        let deptTitle = dept === "customer support" ? "Customer Support" : dept.charAt(0).toUpperCase() + dept.slice(1);
        let yearM = q.match(/hired after (\d{4})/) || q.match(/after (\d{4})/);
        if (yearM) return `SELECT employee_id, name, department, title, hire_date, salary FROM employees WHERE department = '${deptTitle}' AND hire_date > '${yearM[1]}-12-31' ORDER BY hire_date;`;
        return `SELECT employee_id, name, department, title, hire_date, salary FROM employees WHERE department = '${deptTitle}' ORDER BY hire_date;`;
    }
    
    if (q.includes("all employees") || (q.includes("list") && q.includes("employees"))) return "SELECT * FROM employees;";
    if (q.includes("all products") || (q.includes("list") && q.includes("products"))) return "SELECT * FROM products;";
    if (q.includes("all customers") || (q.includes("list") && q.includes("customers"))) return "SELECT * FROM customers;";
    if (q.includes("all orders") || (q.includes("list") && q.includes("orders"))) return "SELECT * FROM orders;";
    if (q.includes("how many customers")) return "SELECT COUNT(*) AS customer_count FROM customers;";
    if (q.includes("how many orders")) return "SELECT COUNT(*) AS order_count FROM orders;";
    if (q.includes("average order") || q.includes("average spend")) return "SELECT AVG(order_total) AS average_order_total FROM orders;";
    if (q.includes("cancelled orders") || q.includes("canceled orders")) return "SELECT * FROM orders WHERE status = 'cancelled';";

    throw new Error("VALIDATION_ERROR: Couldn't confidently translate this request without an LLM connected. Try rephrasing, or set GEMINI_API_KEY for full natural-language coverage.");
}

async function generateSql(question) {
    if (!question || question.trim().length < 4) {
        throw new Error("VALIDATION_ERROR: Please describe the data you need in a bit more detail.");
    }
    if (_looks_like_mutation_request(question)) {
        throw new Error("BLOCKED_ERROR: This looks like a request to change data (insert, update, delete, etc). Only read (SELECT) queries are permitted here.");
    }
    
    const schema = getSchemaSnapshot();
    let source = "llm";
    let rawSql;
    
    try {
        rawSql = await generateSqlViaLlm(question, schema);
        if (!rawSql) throw new Error("empty LLM response");
    } catch (e) {
        source = "rules";
        rawSql = generateSqlViaRules(question);
    }
    
    const validated = validateSql(rawSql);
    return { sql: validated, source };
}

function _humanReadableDbError(msg) {
    msg = msg.toLowerCase();
    if (msg.includes("no such table")) return `The generated query refers to a table that doesn't exist in this database.`;
    if (msg.includes("no such column")) return `The generated query refers to a column that doesn't exist in this database.`;
    if (msg.includes("readonly database") || msg.includes("read-only")) return "That query attempted to modify the database, which isn't permitted here.";
    if (msg.includes("syntax error")) return "The generated SQL had a syntax error and could not be run.";
    return "The query could not be run against the database. Please try rephrasing your request.";
}

function executeSql(sql) {
    const start = Date.now();
    let db;
    try {
        db = getReadonlyConnection();
        const stmt = db.prepare(sql);
        
        let rows = stmt.all();
        const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
        const truncated = rows.length > MAX_ROWS;
        if (truncated) rows = rows.slice(0, MAX_ROWS);

        return {
            ok: true,
            sql,
            columns,
            rows,
            row_count: rows.length,
            truncated,
            elapsed_ms: Date.now() - start
        };
    } catch (e) {
        return { ok: false, stage: "execution", sql, error: _humanReadableDbError(e.message) };
    } finally {
        if (db) db.close();
    }
}

app.post('/api/query', async (req, res) => {
    try {
        const question = (req.body.question || "").trim();
        if (question.length < 4) {
            return res.json({ ok: false, stage: "input", error: "Please describe the data you need — that request looks too short to work with." });
        }
        
        const gen = await generateSql(question);
        const result = executeSql(gen.sql);
        result.source = gen.source;
        res.json(result);
    } catch (e) {
        if (e.message.startsWith("BLOCKED_ERROR:")) return res.json({ ok: false, stage: "blocked", error: e.message.replace("BLOCKED_ERROR:", "").trim() });
        if (e.message.startsWith("VALIDATION_ERROR:")) return res.json({ ok: false, stage: "generation", error: e.message.replace("VALIDATION_ERROR:", "").trim() });
        res.json({ ok: false, stage: "generation", error: `Couldn't generate a query for that: ${e.message}` });
    }
});

app.post('/api/execute', (req, res) => {
    try {
        const validated = validateSql(req.body.sql || "");
        const result = executeSql(validated);
        result.source = "edited";
        res.json(result);
    } catch (e) {
        if (e.message.startsWith("BLOCKED_ERROR:")) return res.json({ ok: false, stage: "blocked", error: e.message.replace("BLOCKED_ERROR:", "").trim() });
        if (e.message.startsWith("VALIDATION_ERROR:")) return res.json({ ok: false, stage: "generation", error: e.message.replace("VALIDATION_ERROR:", "").trim() });
        res.json({ ok: false, stage: "generation", error: e.message });
    }
});

app.get('/api/schema', (req, res) => {
    try {
        res.json({ ok: true, schema: getSchemaSnapshot() });
    } catch (e) {
        res.json({ ok: false, error: e.message });
    }
});

// For local testing without netlify dev
if (require.main === module) {
    app.listen(8000, () => console.log('Local Server running on port 8000'));
}

module.exports.handler = serverless(app);
