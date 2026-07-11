const API_BASE = "";

const nlInput = document.getElementById("nlInput");
const runBtn = document.getElementById("runBtn");
const inputHint = document.getElementById("inputHint");

const sqlPanel = document.getElementById("sqlPanel");
const sqlDisplay = document.getElementById("sqlDisplay");
const sourceBadge = document.getElementById("sourceBadge");
const editToggle = document.getElementById("editToggle");
const editRow = document.getElementById("editRow");
const rerunBtn = document.getElementById("rerunBtn");
const copySqlBtn = document.getElementById("copySqlBtn");

const resultsPanel = document.getElementById("resultsPanel");
const resultsLabel = document.getElementById("resultsLabel");
const tableScroll = document.getElementById("tableScroll");
const pager = document.getElementById("pager");
const prevPageBtn = document.getElementById("prevPage");
const nextPageBtn = document.getElementById("nextPage");
const pageIndicator = document.getElementById("pageIndicator");
const exportBtn = document.getElementById("exportBtn");

const messagePanel = document.getElementById("messagePanel");
const schemaList = document.getElementById("schemaList");
const historyList = document.getElementById("historyList");

const PAGE_SIZE = 20;

let currentResult = null; // { columns, rows, sql, question }
let currentPage = 0;
let history = [];
let activeHistoryIndex = null;

// ---------------- helpers ----------------

function hideAll() {
  sqlPanel.hidden = true;
  resultsPanel.hidden = true;
  messagePanel.hidden = true;
}

function showMessage(stage, text) {
  hideAll();
  messagePanel.hidden = false;
  messagePanel.innerHTML = `<span class="msg-stage">${stage}</span><div>${escapeHtml(text)}</div>`;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

async function typeReveal(el, text) {
  el.textContent = "";
  const cursor = document.createElement("span");
  cursor.className = "type-cursor";
  el.appendChild(document.createTextNode(""));
  el.appendChild(cursor);

  const speed = text.length > 220 ? 2 : text.length > 100 ? 6 : 12;
  let i = 0;
  return new Promise((resolve) => {
    function step() {
      if (i <= text.length) {
        el.textContent = text.slice(0, i);
        el.appendChild(cursor);
        i += Math.max(1, Math.floor(text.length / 60));
        setTimeout(step, speed);
      } else {
        el.textContent = text;
        resolve();
      }
    }
    step();
  });
}

// ---------------- schema explorer ----------------

async function loadSchema() {
  try {
    const res = await fetch(`${API_BASE}/api/schema`);
    const data = await res.json();
    if (!data.ok) {
      schemaList.innerHTML = `<p class="empty-note">${escapeHtml(data.error || "Schema unavailable.")}</p>`;
      return;
    }
    schemaList.innerHTML = "";
    Object.entries(data.schema).forEach(([table, cols]) => {
      const block = document.createElement("div");
      block.className = "schema-table";
      const colText = cols.map((c) => `${c.name}: ${c.type || "?"}`).join(", ");
      block.innerHTML = `<span class="t-name">${table}</span><span class="t-cols">${escapeHtml(colText)}</span>`;
      schemaList.appendChild(block);
    });
  } catch (e) {
    schemaList.innerHTML = `<p class="empty-note">Couldn't reach the server to load the schema.</p>`;
  }
}

// ---------------- results rendering ----------------

function renderResults(columns, rows, rowCount, truncated) {
  resultsPanel.hidden = false;
  resultsLabel.innerHTML = `Results <span class="row-count">Showing ${rowCount} result${rowCount === 1 ? "" : "s"}${truncated ? " (capped at 1000)" : ""}</span>`;

  if (rowCount === 0) {
    tableScroll.innerHTML = `<div class="zero-rows">The query ran successfully but returned no results.</div>`;
    pager.hidden = true;
    return;
  }

  currentPage = 0;
  renderPage(columns, rows);
}

function renderPage(columns, rows) {
  const totalPages = Math.ceil(rows.length / PAGE_SIZE);
  const start = currentPage * PAGE_SIZE;
  const pageRows = rows.slice(start, start + PAGE_SIZE);

  let html = "<table class='results-table'><thead><tr>";
  columns.forEach((c) => (html += `<th>${escapeHtml(c)}</th>`));
  html += "</tr></thead><tbody>";
  pageRows.forEach((row) => {
    html += "<tr>";
    columns.forEach((c) => {
      const val = row[c];
      html += `<td>${val === null || val === undefined ? "<span style='opacity:.4'>null</span>" : escapeHtml(String(val))}</td>`;
    });
    html += "</tr>";
  });
  html += "</tbody></table>";
  tableScroll.innerHTML = html;

  if (totalPages > 1) {
    pager.hidden = false;
    pageIndicator.textContent = `Page ${currentPage + 1} of ${totalPages}`;
    prevPageBtn.disabled = currentPage === 0;
    nextPageBtn.disabled = currentPage >= totalPages - 1;
  } else {
    pager.hidden = true;
  }
}

prevPageBtn.addEventListener("click", () => {
  if (!currentResult) return;
  currentPage = Math.max(0, currentPage - 1);
  renderPage(currentResult.columns, currentResult.rows);
});
nextPageBtn.addEventListener("click", () => {
  if (!currentResult) return;
  currentPage += 1;
  renderPage(currentResult.columns, currentResult.rows);
});

exportBtn.addEventListener("click", () => {
  if (!currentResult || currentResult.rows.length === 0) return;
  const { columns, rows } = currentResult;
  const escapeCsv = (v) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.map(escapeCsv).join(",")];
  rows.forEach((r) => lines.push(columns.map((c) => escapeCsv(r[c])).join(",")));
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "query_results.csv";
  a.click();
  URL.revokeObjectURL(url);
});

// ---------------- history ----------------

function addHistoryEntry(entry) {
  history.unshift(entry);
  activeHistoryIndex = 0;
  renderHistory();
}

function renderHistory() {
  if (history.length === 0) {
    historyList.innerHTML = `<p class="empty-note">Run a query to start building history.</p>`;
    return;
  }
  historyList.innerHTML = "";
  history.forEach((entry, idx) => {
    const item = document.createElement("div");
    item.className = "history-item" + (idx === activeHistoryIndex ? " active" : "") + (entry.error ? " h-error" : "");
    const time = entry.timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    item.innerHTML = `<div class="h-q">${escapeHtml(entry.question)}</div><div class="h-meta">${time} · ${entry.error ? "failed" : entry.rowCount + " rows"}</div>`;
    item.addEventListener("click", () => loadHistoryEntry(idx));
    historyList.appendChild(item);
  });
}

function loadHistoryEntry(idx) {
  const entry = history[idx];
  activeHistoryIndex = idx;
  renderHistory();
  nlInput.value = entry.question;

  if (entry.error) {
    showMessage(entry.stage || "error", entry.error);
    return;
  }

  hideAll();
  sqlPanel.hidden = false;
  sqlDisplay.textContent = entry.sql;
  sourceBadge.textContent = entry.source === "llm" ? "LLM" : entry.source === "edited" ? "edited" : "rules";
  sourceBadge.className = "source-badge" + (entry.source === "rules" ? " rules" : "");
  currentResult = { columns: entry.columns, rows: entry.rows, sql: entry.sql, question: entry.question };
  renderResults(entry.columns, entry.rows, entry.rowCount, entry.truncated);
}

// ---------------- submit flow ----------------

async function submitQuestion(question) {
  inputHint.textContent = "";
  if (!question || question.trim().length < 4) {
    inputHint.textContent = "Describe the data you need — that's too short to work with.";
    return;
  }

  runBtn.disabled = true;
  runBtn.textContent = "Thinking…";
  hideAll();

  try {
    const res = await fetch(`${API_BASE}/api/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question }),
    });
    const data = await res.json();

    if (!data.ok) {
      showMessage(data.stage || "error", data.error);
      addHistoryEntry({ question, error: data.error, stage: data.stage, timestamp: new Date() });
      return;
    }

    sqlPanel.hidden = false;
    sourceBadge.textContent = data.source === "llm" ? "LLM" : "rules";
    sourceBadge.className = "source-badge" + (data.source === "rules" ? " rules" : "");
    await typeReveal(sqlDisplay, data.sql);

    currentResult = { columns: data.columns, rows: data.rows, sql: data.sql, question };
    renderResults(data.columns, data.rows, data.row_count, data.truncated);

    addHistoryEntry({
      question,
      sql: data.sql,
      source: data.source,
      columns: data.columns,
      rows: data.rows,
      rowCount: data.row_count,
      truncated: data.truncated,
      timestamp: new Date(),
    });
  } catch (e) {
    showMessage("network", "Couldn't reach the server. Is the backend running?");
  } finally {
    runBtn.disabled = false;
    runBtn.textContent = "Translate & run →";
  }
}

runBtn.addEventListener("click", () => submitQuestion(nlInput.value));
nlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submitQuestion(nlInput.value);
});

document.getElementById("examples").addEventListener("click", (e) => {
  const btn = e.target.closest(".chip");
  if (!btn) return;
  nlInput.value = btn.dataset.q;
  submitQuestion(btn.dataset.q);
});

// ---------------- edit + rerun ----------------

let editing = false;
editToggle.addEventListener("click", () => {
  editing = !editing;
  sqlDisplay.contentEditable = editing ? "true" : "false";
  editToggle.textContent = editing ? "Lock" : "Edit";
  editRow.hidden = !editing;
  if (editing) sqlDisplay.focus();
});

rerunBtn.addEventListener("click", async () => {
  const editedSql = sqlDisplay.textContent.trim();
  rerunBtn.disabled = true;
  rerunBtn.textContent = "Running…";
  try {
    const res = await fetch(`${API_BASE}/api/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sql: editedSql }),
    });
    const data = await res.json();
    if (!data.ok) {
      showMessage(data.stage || "error", data.error);
      return;
    }
    sqlPanel.hidden = false;
    sourceBadge.textContent = "edited";
    sourceBadge.className = "source-badge rules";
    currentResult = { columns: data.columns, rows: data.rows, sql: data.sql, question: nlInput.value || "(edited query)" };
    renderResults(data.columns, data.rows, data.row_count, data.truncated);
    addHistoryEntry({
      question: `(edited) ${nlInput.value || editedSql.slice(0, 60)}`,
      sql: data.sql,
      source: "edited",
      columns: data.columns,
      rows: data.rows,
      rowCount: data.row_count,
      truncated: data.truncated,
      timestamp: new Date(),
    });
  } catch (e) {
    showMessage("network", "Couldn't reach the server to run the edited query.");
  } finally {
    rerunBtn.disabled = false;
    rerunBtn.textContent = "Run edited query";
  }
});

copySqlBtn.addEventListener("click", async () => {
  const text = sqlDisplay.textContent;
  try {
    await navigator.clipboard.writeText(text);
    copySqlBtn.textContent = "Copied";
    setTimeout(() => (copySqlBtn.textContent = "Copy"), 1200);
  } catch (e) {
    /* clipboard API may be unavailable; fail silently */
  }
});

// ---------------- init ----------------
loadSchema();
