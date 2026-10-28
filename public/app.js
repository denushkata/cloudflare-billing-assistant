// Front end for the reconciliation API. All amounts arrive as integer cents computed
// on the server; this file only formats and displays them.

const $ = (sel) => document.querySelector(sel);
const statusEl = $("#status");
const resultsEl = $("#results");
const analystEl = $("#analyst");
const buttons = [$("#demo"), $("#check"), $("#reset")];

// ---------- helpers ----------

/** Build DOM nodes without innerHTML, so model output and analyst notes are always plain text. */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === "class") el.className = v;
    else if (k === "style") Object.assign(el.style, v); // CSSOM, which the strict CSP allows (style attributes it would block)
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

function money(cents) {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
}
const signed = (cents) => (cents > 0 ? `+${money(cents)}` : money(cents));
const direction = (cents) => (cents > 0 ? "customer overcharged" : cents < 0 ? "customer undercharged" : "no net difference");
const when = (iso) => (iso ? new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "");
const STATUS_LABEL = { open: "Open", resolved: "Resolved", escalated: "Escalated", explained: "Explained", flagged: "Flagged", clean: "Clean" };

function setStatus(message, { busy = false, error = false } = {}) {
  statusEl.hidden = !message;
  statusEl.className = `status${error ? " error" : ""}`;
  statusEl.replaceChildren(...(busy ? [h("span", { class: "spinner", "aria-hidden": "true" })] : []), h("span", {}, message));
}

function setBusy(busy) {
  for (const b of buttons) b.disabled = busy;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---------- analyst name (per-browser convenience only) ----------

// The name is never blank: a first-time visitor gets "reviewer", and an empty or invalid
// edit snaps back to the last valid name. Same rule as the server (src/safety.ts).
// In production the name would come from the signed-in identity instead.
const NAME_PATTERN = /^[\p{L}\p{M}][\p{L}\p{M}0-9 .'_-]{0,99}$/u;
const NAME_HINT = "In production this comes from your sign-in, not a typed name.";
const analystHint = $("#analyst-hint");
let analystName = "reviewer";
try {
  const saved = localStorage.getItem("analyst");
  if (saved && NAME_PATTERN.test(saved)) analystName = saved;
} catch {}
analystEl.value = analystName;

function setNameHint(text, error) {
  analystHint.textContent = text;
  analystHint.classList.toggle("error", error);
  analystEl.setAttribute("aria-invalid", String(error));
}

analystEl.addEventListener("input", () => {
  const v = analystEl.value.trim();
  if (!v) setNameHint("Your name can't be blank; it goes in the audit trail.", true);
  else if (!NAME_PATTERN.test(v)) setNameHint("Use letters, digits, spaces and . ' _ - only.", true);
  else setNameHint(NAME_HINT, false);
});

analystEl.addEventListener("change", () => {
  const v = analystEl.value.trim();
  if (NAME_PATTERN.test(v)) {
    analystName = v;
    analystEl.value = v;
    setNameHint(NAME_HINT, false);
    try {
      localStorage.setItem("analyst", v);
    } catch {}
  } else {
    analystEl.value = analystName;
    setNameHint(`${v ? "That name isn't allowed" : "Your name can't be blank"}, so it's back to “${analystName}”.`, true);
  }
});

// ---------- dialogs ----------

for (const d of document.querySelectorAll("dialog")) {
  d.querySelector("[data-close]").addEventListener("click", () => d.close());
  d.addEventListener("click", (ev) => {
    if (ev.target === d) d.close(); // click on the backdrop
  });
}
$("#how-open").addEventListener("click", () => $("#how").showModal());

// ---------- "Try this" checklist (ticks itself; progress kept in this browser only) ----------

const TOUR_KEY = "tour.v1";
const TOUR_STEPS = [
  { id: "load", text: "Load the sample data", show: () => run({ sample: true }, "Sample data") },
  {
    id: "precedent",
    text: "See persistence at work: C004's “Seen before” suggestion",
    show: () => showCard("INV-2026-10-004:tax_wrong_state", ".block.precedent").then(() => markTour("precedent")),
  },
  { id: "decide", text: "Resolve or escalate an issue, with a note", show: () => showFirstOpen() },
  { id: "history", text: "Open a customer's history to see the audit trail", show: () => withResults(() => openHistory("C004")) },
];

let tour = loadTour();

function loadTour() {
  try {
    const saved = JSON.parse(localStorage.getItem(TOUR_KEY) ?? "{}");
    return { done: Array.isArray(saved.done) ? saved.done : [], hidden: saved.hidden === true };
  } catch {
    return { done: [], hidden: false };
  }
}

function saveTour() {
  try {
    localStorage.setItem(TOUR_KEY, JSON.stringify(tour));
  } catch {}
}

function markTour(id) {
  if (tour.done.includes(id)) return;
  tour.done.push(id);
  saveTour();
  renderTour();
}

function resetTour() {
  tour = { done: [], hidden: false };
  saveTour();
  renderTour();
}

function setTourHidden(hidden) {
  tour.hidden = hidden;
  saveTour();
  renderTour();
}

function renderTour() {
  const el = $("#tour");
  el.hidden = tour.hidden;
  $("#tour-open").hidden = !tour.hidden;
  if (tour.hidden) return;
  const doneCount = TOUR_STEPS.filter((s) => tour.done.includes(s.id)).length;
  el.replaceChildren(
    h(
      "div",
      { class: "tour-head" },
      h("h2", { id: "tour-title" }, "Try this"),
      h("span", { class: "meta" }, doneCount === TOUR_STEPS.length ? "All done. Thanks for trying it." : `${doneCount} of ${TOUR_STEPS.length} done`),
      h(
        "span",
        { class: "tour-actions" },
        doneCount ? h("button", { type: "button", class: "link", onclick: resetTour }, "Start over") : null,
        h("button", { type: "button", class: "link", onclick: () => setTourHidden(true) }, "Hide"),
      ),
    ),
    h(
      "ol",
      { class: "tour-steps" },
      TOUR_STEPS.map((s) => {
        const done = tour.done.includes(s.id);
        return h(
          "li",
          { class: done ? "done" : "" },
          h("span", { class: "tick", "aria-hidden": "true" }, done ? "✓" : ""),
          h("span", { class: "text" }, s.text, done ? h("span", { class: "sr-only" }, " (done)") : null),
          done ? null : h("button", { type: "button", class: "link", onclick: s.show }, "Show me"),
        );
      }),
    ),
  );
}

$("#tour-open").addEventListener("click", () => setTourHidden(false));
renderTour();

/** Run the demo first if nothing is on screen yet. */
async function withResults(fn) {
  if (!current) await run({ sample: true }, "Sample data");
  if (current) return fn();
}

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function spotlight(el) {
  el.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "center" });
  el.classList.add("spotlight");
  setTimeout(() => el.classList.remove("spotlight"), 2500);
}

/** Bring a finding card into view, clearing filters or opening the Resolved list if they hide it. */
function showCard(findingId, innerSelector) {
  return withResults(() => {
    let card = document.getElementById(`f-${findingId}`);
    if (!card) {
      clearFilters(current);
      card = document.getElementById(`f-${findingId}`);
    }
    if (!card) return;
    const details = card.closest("details");
    if (details) details.open = true;
    spotlight((innerSelector && card.querySelector(innerSelector)) || card);
  });
}

function showFirstOpen() {
  return withResults(() => {
    const f = current.invoices.flatMap((inv) => inv.findings).find((x) => x.status === "open" || x.status === "escalated");
    if (!f) {
      setStatus("Every issue is decided. Use “Reset demo history” to start over.");
      return;
    }
    showCard(f.id).then(() => document.getElementById(`f-${f.id}`)?.querySelector("textarea")?.focus({ preventScroll: true }));
  });
}

// ---------- running a check ----------

async function run(body, label) {
  setBusy(true);
  resultsEl.replaceChildren();
  setStatus(`${label}: calculating, then writing explanations with Workers AI (up to 10 seconds)…`, { busy: true });
  try {
    const data = await api("/api/reconcile", { method: "POST", body: JSON.stringify(body) });
    setStatus("");
    renderResults(data);
  } catch (e) {
    setStatus(e.message, { error: true });
  } finally {
    setBusy(false);
  }
}

$("#demo").addEventListener("click", () => run({ sample: true }, "Sample data"));

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

$("#upload-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const form = new FormData(ev.target);
  const chosen = ["usage", "invoices", "plans", "creditMemos"].map((name) => [name, form.get(name)]).filter(([, f]) => f && f.size);
  const bytes = chosen.reduce((n, [, f]) => n + f.size, 0);
  if (bytes > MAX_UPLOAD_BYTES) {
    // Same limit the server enforces; checking here saves uploading megabytes only to be refused.
    setStatus(`These files total ${(bytes / 1024 / 1024).toFixed(1)} MB; one check accepts up to 5 MB. Split the usage export by customer or by week, or summarize it to daily totals per customer.`, { error: true });
    return;
  }
  const files = {};
  for (const [name, file] of chosen) files[name] = await file.text();
  if (!files.usage || !files.invoices) {
    setStatus("Choose at least usage.csv and invoices.csv.", { error: true });
    return;
  }
  run({ files }, "Your files");
});

$("#reset").addEventListener("click", async () => {
  if (!confirm("Clear all decisions on the sample customers, restore the demo history, and restart the Try this checklist?")) return;
  setBusy(true);
  try {
    await api("/api/demo/reset", { method: "POST", body: "{}" });
    current = null;
    resultsEl.replaceChildren();
    resetTour(); // a fresh demo starts with a fresh checklist
    setStatus("Demo history and checklist reset. Click “Load sample data” to run it again.");
  } catch (e) {
    setStatus(e.message, { error: true });
  } finally {
    setBusy(false);
  }
});

// ---------- results ----------

function renderResults(data) {
  const findings = data.invoices.flatMap((inv) => inv.findings);
  current = data;
  const aiOk = findings.filter((f) => f.ai?.status === "ok").length;
  const sourceNote = Object.values(data.sources).includes("uploaded")
    ? ` · files: ${Object.entries(data.sources).map(([k, v]) => `${k} ${v}`).join(", ")}`
    : "";

  resultsEl.replaceChildren(
    h(
      "section",
      { "aria-label": "Summary" },
      tilesEl,
      h(
        "p",
        { class: "meta" },
        `Period ${data.period.join(", ")} · this check flagged ${data.counts.flagged} of ${data.counts.invoices} invoices · ${aiOk} of ${findings.length} explanations from ${data.ai.model.split("/").pop()} · ${(data.durationMs / 1000).toFixed(1)}s${sourceNote}`,
      ),
      data.warnings.map((w) => h("p", { class: "warn" }, w)),
    ),
    dataNotes(data),
    insightsEl,
    chatEl,
    toolbar(data),
    listsEl,
  );
  openChat(data); // sets the session first, so the cards rendered next get their "Ask" buttons
  renderLists();
  markTour("load");
  loadInsights(data, { narrative: true });
}

// ---------- chat (answers come from Workers AI, using only the server's stored results and ledgers) ----------

const chatEl = h("section", { class: "chat panel", "aria-label": "Ask about these results" });
const chat = { sessionId: null, messages: [], focus: null, busy: false, error: "" };
const chatLog = h("div", { class: "chat-log", "aria-live": "polite" });
const chatInput = h("textarea", {
  rows: "2",
  maxlength: "500",
  placeholder: "Ask about these results, e.g. why was C002 flagged?",
  "aria-label": "Question about these results",
  onkeydown: (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      sendQuestion();
    }
  },
});
const chatSend = h("button", { type: "button", class: "primary", onclick: () => sendQuestion() }, "Ask");
const chatFocusEl = h("div", { class: "chat-focus" });
const chatSuggestEl = h("div", { class: "chat-suggest" });
const chatMsgEl = h("p", { class: "msg", role: "alert" });

chatEl.append(
  h("div", { class: "chat-head" }, h("h2", {}, "Ask about these results"), h("span", { class: "hint" }, "Answers come only from the calculated results and each customer's history. The model never computes an amount.")),
  chatLog,
  chatSuggestEl,
  chatFocusEl,
  h("div", { class: "chat-form" }, chatInput, chatSend),
  chatMsgEl,
);

async function openChat(data) {
  Object.assign(chat, { sessionId: data.sessionId ?? null, messages: [], focus: null, busy: false, error: "" });
  chatEl.hidden = !chat.sessionId;
  chatSuggestEl.replaceChildren(...suggestions(data).map((q) => h("button", { type: "button", class: "chip-button", onclick: () => ask(q) }, q)));
  renderChat();
  if (!chat.sessionId) return;
  try {
    const { messages } = await api(`/api/sessions/${chat.sessionId}/messages`);
    if (data === current) chat.messages = messages;
  } catch {
    // An empty thread is fine; asking will surface any real problem.
  }
  renderChat();
}

/** Starting points built from these results, so a reviewer sees what kinds of question work. */
function suggestions(data) {
  const findings = data.invoices.flatMap((i) => i.findings).filter((f) => f.severity === "error");
  const largest = [...findings].sort((a, b) => Math.abs(b.differenceCents) - Math.abs(a.differenceCents))[0];
  const repeat = findings.find((f) => f.precedent);
  return [
    largest ? `Why was ${largest.invoiceId} flagged?` : null,
    repeat ? `Has ${repeat.customerId} had this issue before?` : null,
    findings.length ? "Which issue costs customers the most in this check?" : null,
    findings.length ? "What would the total be if we waived all overage?" : null,
  ].filter(Boolean);
}

/** From a card's "Ask" button: scope the next question to that finding. */
function askAbout(f) {
  chat.focus = f;
  renderChat();
  chatInput.value = f.severity === "explained" ? "Why is this correct?" : "Why was this flagged?";
  chatEl.scrollIntoView({ behavior: "smooth", block: "start" });
  chatInput.focus();
}

function ask(question) {
  chatInput.value = question;
  sendQuestion();
}

async function sendQuestion() {
  const question = chatInput.value.trim();
  if (!question || chat.busy || !chat.sessionId) return;
  chat.busy = true;
  chat.error = "";
  const focus = chat.focus;
  chat.pending = question;
  chatInput.value = "";
  renderChat();
  try {
    const { messages } = await api(`/api/sessions/${chat.sessionId}/messages`, {
      method: "POST",
      body: JSON.stringify({ question, analyst: analystName, ...(focus ? { focus: focus.id } : {}) }),
    });
    chat.messages.push(...messages);
    chat.focus = null;
  } catch (e) {
    chat.error = `${capitalize(e.message)}${/[.!?]$/.test(e.message) ? "" : "."}`;
    chatInput.value = question; // nothing was lost
  } finally {
    chat.busy = false;
    chat.pending = null;
    renderChat();
  }
}

function renderChat() {
  chatLog.replaceChildren(...[
    ...(chat.messages.length || chat.pending
      ? []
      : [h("p", { class: "hint" }, "Try a suggestion below, or use “Ask” on any card to ask about that finding.")]),
    ...chat.messages.map(chatMessage),
    chat.pending ? h("div", { class: "chat-msg analyst" }, h("p", {}, chat.pending)) : null,
    chat.busy ? h("div", { class: "chat-msg assistant pending" }, h("span", { class: "spinner", "aria-hidden": "true" }), " Looking at the results…") : null,
  ].filter(Boolean));
  chatLog.scrollTop = chatLog.scrollHeight;
  chatFocusEl.replaceChildren(
    ...(chat.focus
      ? [
          h("span", {}, `About: ${capitalize(chat.focus.label)} · ${chat.focus.invoiceId}`),
          h("button", { type: "button", class: "link", "aria-label": "Stop asking about this finding", onclick: () => ((chat.focus = null), renderChat()) }, "✕"),
        ]
      : []),
  );
  chatFocusEl.hidden = !chat.focus;
  chatSend.disabled = chat.busy;
  chatMsgEl.textContent = chat.error;
}

function chatMessage(m) {
  if (m.role === "analyst") return h("div", { class: "chat-msg analyst" }, h("span", { class: "who" }, m.author), h("p", {}, m.text));
  return h(
    "div",
    { class: `chat-msg assistant${m.status === "ok" ? "" : " unavailable"}` },
    h("span", { class: "who" }, m.status === "ok" ? `AI · ${m.author}` : "AI answer unavailable"),
    h("p", {}, m.text),
    m.missing ? h("p", { class: "missing" }, h("strong", {}, "Not in the results: "), m.missing) : null,
    m.cited.length
      ? h("p", { class: "cited" }, "Based on: ", m.cited.map((id) => h("button", { type: "button", class: "link", onclick: () => showFinding(id) }, id)))
      : null,
  );
}

/** Scroll to a cited finding's card, opening the Resolved list if it is there. */
function showFinding(id) {
  const card = document.getElementById(`f-${id}`);
  if (!card) return setStatus(`${id} is hidden by the current filters.`);
  const folded = card.closest("details");
  if (folded) folded.open = true;
  card.scrollIntoView({ behavior: "smooth", block: "center" });
  card.classList.add("spotlight");
  setTimeout(() => card.classList.remove("spotlight"), 2000);
}

/** Rows that could not be read and how the data was interpreted. Open by default when rows were rejected. */
function dataNotes(data) {
  const rejected = data.rejected ?? [];
  const notices = data.notices ?? [];
  if (!rejected.length && !notices.length) return null;
  const more = (shown, total) => (total > shown ? h("li", { class: "more" }, `…and ${total - shown} more`) : null);
  const parts = [
    rejected.length ? `${data.rejectedCount} ${data.rejectedCount === 1 ? "row" : "rows"} could not be read` : null,
    notices.length ? `${data.noticeCount} ${data.noticeCount === 1 ? "note" : "notes"} on how the data was read` : null,
  ].filter(Boolean);
  return h(
    "details",
    { class: "data-notes", open: rejected.length > 0 },
    h("summary", {}, h("strong", {}, "Data checks"), h("span", { class: "hint" }, ` ${parts.join(" · ")}`)),
    rejected.length
      ? h(
          "div",
          {},
          h("p", { class: "hint" }, "These rows were left out. A customer with a rejected plan, usage or invoice row is not checked, so it is never reported as clean on partial data."),
          h("ul", { class: "rows" }, rejected.map((r) => h("li", {}, h("span", { class: "line" }, r.line), ` ${r.reason}`)), more(rejected.length, data.rejectedCount)),
        )
      : null,
    notices.length ? h("ul", { class: "rows" }, notices.map((n) => h("li", {}, n)), more(notices.length, data.noticeCount)) : null,
  );
}

// ---------- insights (all numbers come from /api/insights; the model only writes the summary) ----------

const insightsEl = h("details", { class: "insights", open: true });
let insightsRequest = 0;

function insightScope(data) {
  return {
    period: [...data.period].sort().pop(),
    customers: [...new Set(data.invoices.map((i) => i.customerId))],
  };
}

async function loadInsights(data, { narrative = false } = {}) {
  const request = ++insightsRequest;
  const { period, customers } = insightScope(data);
  if (!insightsEl.childElementCount) insightsEl.replaceChildren(insightsHead(period), h("p", { class: "meta" }, "Loading insights…"));
  try {
    const { insights, warnings } = await api(`/api/insights?period=${encodeURIComponent(period)}&customers=${customers.map(encodeURIComponent).join(",")}`);
    if (request !== insightsRequest) return; // a newer refresh already rendered
    insightsEl.dataset.summary = insights.summary;
    const narrativeEl = insightsEl.querySelector(".narrative") ?? narrativeBlock(insights.summary, null);
    insightsEl.replaceChildren(
      insightsHead(period),
      narrativeEl,
      warnings.map((w) => h("p", { class: "warn" }, w)),
      h("div", { class: "insight-grid" }, exposureCard(insights), rootCauseCard(insights), agingCard(insights), hotspotCard(insights)),
    );
    if (narrative) loadNarrative(data);
  } catch (e) {
    insightsEl.replaceChildren(insightsHead(period), h("p", { class: "warn" }, `Insights unavailable: ${e.message}`));
  }
}

async function loadNarrative(data) {
  const scope = insightScope(data);
  const current = insightsEl.querySelector(".narrative");
  if (current) current.replaceWith(narrativeBlock(null, null, true));
  let result;
  try {
    ({ narrative: result } = await api("/api/insights/narrative", { method: "POST", body: JSON.stringify(scope) }));
  } catch (e) {
    result = { status: "unavailable", note: `Summary unavailable: ${e.message}` };
  }
  const fallback = insightsEl.dataset.summary ?? "";
  insightsEl.querySelector(".narrative")?.replaceWith(narrativeBlock(fallback, result));
}

function insightsHead(period) {
  return h("summary", {}, h("h2", {}, "Insights"), h("span", { class: "meta" }, `Period ${period} · issue amounts as shown on each card`));
}

/** AI summary when available; otherwise the code-written summary with a short note. */
function narrativeBlock(fallback, result, loading = false) {
  if (fallback != null) insightsEl.dataset.summary = fallback;
  const refresh = h("button", { type: "button", class: "link", onclick: () => current && loadNarrative(current) }, "Refresh summary");
  if (loading) return h("div", { class: "block ai narrative" }, h("span", { class: "tag" }, "AI summary"), h("p", { class: "meta" }, "Writing a summary with Workers AI…"));
  if (result?.status === "ok") {
    return h("div", { class: "block ai narrative" }, h("span", { class: "tag" }, "AI summary · from the metrics below"), h("p", {}, result.text), h("p", { class: "source" }, refresh));
  }
  return h(
    "div",
    { class: "block ai narrative" },
    h("span", { class: "tag" }, "Summary"),
    h("p", {}, insightsEl.dataset.summary ?? ""),
    result ? h("p", { class: "unavailable" }, result.note, " ", refresh) : null,
  );
}

const STATUS_PARTS = [
  ["open", "Open"],
  ["escalated", "Escalated"],
  ["resolved", "Resolved"],
];

/** A stacked bar of open / escalated / resolved amounts, labelled in text so color is never the only cue. */
function statusBar(label, sub, side) {
  const segments = STATUS_PARTS.filter(([k]) => side[k] > 0).map(([k, name]) =>
    h("span", { class: `seg ${k}`, style: { flexGrow: String(side[k]) }, title: `${name}: ${money(side[k])}` }),
  );
  return h(
    "div",
    { class: "exposure-row" },
    h("div", { class: "row-head" }, h("span", {}, h("strong", {}, label), h("small", {}, ` · ${sub}`)), h("strong", { class: "num" }, money(side.total))),
    side.total ? h("div", { class: "stack", role: "img", "aria-label": `${label}: ${STATUS_PARTS.map(([k, n]) => `${n} ${money(side[k])}`).join(", ")}` }, segments) : h("div", { class: "stack empty" }),
    h(
      "p",
      { class: "legend" },
      STATUS_PARTS.map(([k, name]) => h("span", {}, h("i", { class: `swatch ${k}`, "aria-hidden": "true" }), `${name} ${money(side[k])}`)),
    ),
  );
}

function exposureCard(x) {
  return h(
    "section",
    { class: "card insight" },
    h("h3", {}, "Exposure"),
    statusBar("Overcharged", "refund exposure", x.exposure.overchargedCents),
    statusBar("Undercharged", "revenue leakage", x.exposure.underchargedCents),
  );
}

function rootCauseCard(x) {
  const max = Math.max(1, ...x.rootCauses.map((r) => r.totalCents));
  return h(
    "section",
    { class: "card insight" },
    h("h3", {}, "Root causes"),
    x.rootCauses.length
      ? h(
          "ol",
          { class: "bars" },
          x.rootCauses.map((r) =>
            h(
              "li",
              { title: `${capitalize(r.label)}: ${r.count} issue${r.count === 1 ? "" : "s"}, ${money(r.totalCents)}` },
              h("span", { class: "bar-label" }, capitalize(r.label)),
              h("span", { class: "bar-track" }, h("span", { class: "bar", style: { width: `${Math.max(2, (r.totalCents / max) * 100)}%` } })),
              h("span", { class: "num" }, money(r.totalCents)),
            ),
          ),
        )
      : h("p", { class: "meta" }, "No errors this period."),
  );
}

function agingCard(x) {
  const o = x.aging.oldest;
  return h(
    "section",
    { class: "card insight" },
    h("h3", {}, "Aging and recurrence"),
    h(
      "dl",
      { class: "facts" },
      x.aging.buckets.flatMap((b) => [h("dt", {}, `Open or escalated, ${b.label}`), h("dd", { class: "num" }, b.count)]),
      h("dt", {}, "Oldest open"),
      h("dd", {}, o ? [customerButton(o.customerId), ` ${o.ageDays} day${o.ageDays === 1 ? "" : "s"}, ${STATUS_LABEL[o.status].toLowerCase()}`] : "None"),
      h("dt", {}, "Repeats of an earlier decided issue"),
      h("dd", { class: "num" }, `${x.recurrence.repeats} of ${x.recurrence.of} (${x.recurrence.percent}%)`),
      h("dt", {}, "Median time to resolve"),
      h("dd", { class: "num" }, x.medianHoursToResolve == null ? "None resolved yet" : x.medianHoursToResolve < 1 ? "Under 1 h" : `${x.medianHoursToResolve} h`),
    ),
  );
}

function hotspotCard(x) {
  return h(
    "section",
    { class: "card insight" },
    h("h3", {}, "Customer hotspots"),
    x.hotspots.length
      ? h(
          "table",
          { class: "compact" },
          h("thead", {}, h("tr", {}, h("th", {}, "Customer"), h("th", { class: "num" }, "Open amount"), h("th", { class: "num" }, "Open issues"), h("th", {}, ""))),
          h(
            "tbody",
            {},
            x.hotspots.map((c) =>
              h(
                "tr",
                {},
                h("td", {}, customerButton(c.customerId)),
                h("td", { class: "num" }, money(c.openCents)),
                h("td", { class: "num" }, `${c.open} of ${c.issues}`),
                h("td", {}, c.repeats ? h("span", { class: "badge escalated" }, "Repeat") : ""),
              ),
            ),
          ),
        )
      : h("p", { class: "meta" }, "No open issues."),
  );
}

// Tick "See persistence at work" once a "Seen before" block has actually been on screen.
const precedentSeen = new IntersectionObserver(
  (entries) => {
    if (entries.some((e) => e.isIntersecting)) markTour("precedent");
  },
  { threshold: 0.6 },
);

// ---------- slicing and sorting (client-side view only) ----------

let current = null; // last reconciliation response
const filters = { customer: "", period: "", status: "", sort: "customer" };
const listsEl = h("div", { class: "lists" });
const tilesEl = h("div", { class: "tiles" });

/** Tiles count invoices by the same review status the All invoices table shows, so the two always agree. */
function renderTiles(data) {
  const statuses = data.invoices.map(reviewStatus);
  const n = (s) => statuses.filter((x) => x === s).length;
  tilesEl.replaceChildren(
    tile(data.invoices.length, "Invoices checked", ""),
    tile(n("flagged"), "Flagged, open", "flagged"),
    tile(n("escalated"), "Escalated", "escalated"),
    tile(n("resolved"), "Resolved", "resolved"),
    tile(n("explained"), "Explained", "explained"),
    tile(n("clean"), "Clean", "clean"),
  );
}
const STATUS_ORDER = { open: 0, escalated: 1, resolved: 2, explained: 3, flagged: 0, clean: 4 };
const SORTS = {
  customer: { label: "Customer", cmp: (a, b) => a.customerId.localeCompare(b.customerId) || a.invoiceId.localeCompare(b.invoiceId) },
  period: { label: "Period, newest first", cmp: (a, b) => b.period.localeCompare(a.period) || a.customerId.localeCompare(b.customerId) },
  decided: {
    label: "Recently decided",
    cmp: (a, b) => (b.decidedAt ?? "").localeCompare(a.decidedAt ?? "") || a.customerId.localeCompare(b.customerId),
  },
  status: { label: "Status", cmp: (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.customerId.localeCompare(b.customerId) },
  difference: {
    label: "Largest difference",
    cmp: (a, b) => Math.abs(b.differenceCents) - Math.abs(a.differenceCents) || a.customerId.localeCompare(b.customerId),
  },
};

function toolbar(data) {
  const customers = [...new Set(data.invoices.map((i) => i.customerId))].sort();
  const periods = [...new Set(data.invoices.map((i) => i.period))].sort().reverse();
  // Keep a choice that still exists in the new results; drop one that doesn't.
  if (!customers.includes(filters.customer)) filters.customer = "";
  if (!periods.includes(filters.period)) filters.period = "";

  const select = (key, label, options) => {
    const el = h(
      "select",
      { onchange: (ev) => ((filters[key] = ev.target.value), renderLists()) },
      options.map(([value, text]) => h("option", { value, selected: filters[key] === value }, text)),
    );
    return h("label", {}, h("span", {}, label), el);
  };
  const statuses = ["open", "escalated", "resolved", "explained"];

  return h(
    "div",
    { class: "toolbar card", role: "group", "aria-label": "Filter and sort results" },
    select("customer", "Customer", [["", "All customers"], ...customers.map((c) => [c, c])]),
    select("period", "Period", [["", "All periods"], ...periods.map((p) => [p, p])]),
    select("status", "Status", [["", "Any status"], ...statuses.map((s) => [s, STATUS_LABEL[s]])]),
    select("sort", "Sort by", Object.entries(SORTS).map(([k, v]) => [k, v.label])),
    h("button", { type: "button", class: "link", onclick: () => clearFilters(data) }, "Clear"),
  );
}

function clearFilters(data) {
  Object.assign(filters, { customer: "", period: "", status: "", sort: "customer" });
  renderResults(data);
}

function renderLists() {
  const data = current;
  const all = data.invoices.flatMap((inv) => inv.findings);
  const matches = (x) => (!filters.customer || x.customerId === filters.customer) && (!filters.period || x.period === filters.period);
  const shown = all.filter((f) => matches(f) && (!filters.status || f.status === filters.status)).sort(SORTS[filters.sort].cmp);
  const pending = shown.filter((f) => f.status === "open" || f.status === "escalated");
  const resolved = shown.filter((f) => f.status === "resolved");
  const explained = shown.filter((f) => f.status === "explained");
  const filtered = filters.customer || filters.period || filters.status;
  const invoices = data.invoices
    .filter(matches)
    .map((inv) => ({ ...inv, status: reviewStatus(inv) }))
    .sort(SORTS[filters.sort].cmp);
  const count = (s) => all.filter((f) => f.status === s).length;

  renderTiles(data);
  listsEl.replaceChildren(
    ...[
      h(
        "p",
        { class: "meta progress" },
        `Issues: ${count("open")} open · ${count("escalated")} escalated · ${count("resolved")} resolved`,
        filtered ? ` · showing ${shown.length} of ${all.length} findings` : "",
      ),
      section(
        "Needs review",
        pending.length ? "Open and escalated issues. Resolved issues move to the Resolved list." : "",
        pending.length
          ? pending.map(findingCard)
          : [h("p", { class: "no-action" }, filtered ? "No open or escalated issues match these filters." : "Nothing left to review.")],
      ),
      resolved.length
        ? h(
            "details",
            { class: "done", open: filters.status === "resolved" },
            h("summary", {}, h("h2", {}, `Resolved (${resolved.length})`), h("span", { class: "meta" }, "Decisions are final and kept in each customer's history.")),
            h("div", { class: "list" }, resolved.map(findingCard)),
          )
        : null,
      explained.length ? section("Explained", "Looks different, but is correct.", explained.map(findingCard)) : null,
      section("All invoices", "Totals include tax and approved credits.", [invoiceTable(invoices)]),
    ].filter(Boolean),
  );
  precedentSeen.disconnect();
  listsEl.querySelectorAll(".block.precedent").forEach((el) => precedentSeen.observe(el));
}

/** An invoice the check flagged is "flagged" while any issue is open, then escalated, then resolved. */
function reviewStatus(inv) {
  if (inv.status !== "flagged") return inv.status;
  const statuses = inv.findings.filter((f) => f.severity === "error").map((f) => f.status);
  if (statuses.includes("open")) return "flagged";
  if (statuses.includes("escalated")) return "escalated";
  return "resolved";
}

function tile(n, label, cls) {
  return h("div", { class: `card tile ${cls}` }, h("div", { class: "n" }, n), h("div", { class: "l" }, label));
}

function section(title, hint, children) {
  return h(
    "section",
    {},
    h("div", { class: "section-head" }, h("h2", {}, title), hint ? h("p", {}, hint) : null),
    h("div", { class: "list" }, children),
  );
}

function customerButton(customerId) {
  return h("button", { type: "button", class: "link", onclick: () => openHistory(customerId), title: `Open ${customerId} history` }, customerId);
}

function findingCard(f) {
  const badge = h("span", { class: `badge ${f.status}` }, STATUS_LABEL[f.status] ?? f.status);
  return h(
    "article",
    { class: "finding", id: `f-${f.id}` },
    h(
      "div",
      { class: "finding-head" },
      badge,
      h("h3", {}, capitalize(f.label)),
      h("span", { class: "where" }, "Customer ", customerButton(f.customerId), ` · ${f.invoiceId} · ${f.period}`),
      f.plantedCase ? h("span", { class: "chip", title: f.plantedCase.title }, `Planted case ${f.plantedCase.number} of 8`) : null,
      chat.sessionId ? h("button", { type: "button", class: "link ask", onclick: () => askAbout(f), "aria-label": `Ask about ${f.label} on ${f.invoiceId}` }, "Ask") : null,
    ),
    h(
      "dl",
      { class: "amounts" },
      amount("Expected", money(f.expectedCents)),
      amount("Invoiced", money(f.invoicedCents)),
      amount("Difference", signed(f.differenceCents), direction(f.differenceCents)),
    ),
    h("div", { class: "block" }, h("span", { class: "tag" }, "Calculated"), h("p", {}, f.summary)),
    quotedBlock(f.quoted),
    aiBlock(f.ai),
    precedentBlock(f),
    f.severity === "error" ? decisionArea(f) : h("p", { class: "no-action" }, "No action needed: the invoice is correct."),
  );
}

const QUOTED_LABEL = { line_items: "Line item", unmatched_line_items: "Line item", memo_reason: "Memo reason" };

/** Text copied from the uploaded files, shown verbatim as text (never interpreted) so a reviewer can see exactly what the model saw. */
function quotedBlock(quoted) {
  if (!quoted) return null;
  const items = Object.entries(quoted).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map((text) => [QUOTED_LABEL[k] ?? k, text]));
  return h(
    "div",
    { class: "block quoted" },
    h("span", { class: "tag" }, "From the file"),
    h("ul", {}, items.map(([label, text]) => h("li", {}, h("span", { class: "label" }, `${label}: `), h("q", {}, text)))),
  );
}

function amount(label, value, sub) {
  return h("div", {}, h("dt", {}, label), h("dd", {}, value, sub ? h("span", { class: "dir" }, sub) : null));
}

function aiBlock(ai) {
  if (!ai || ai.status !== "ok") {
    return h(
      "div",
      { class: "block ai" },
      h("span", { class: "tag" }, "AI explanation"),
      h("p", { class: "unavailable" }, ai?.note ?? "Explanation unavailable."),
    );
  }
  return h(
    "div",
    { class: "block ai" },
    h("span", { class: "tag" }, "AI explanation"),
    h("p", {}, ai.explanation),
    h("p", {}, h("strong", {}, "Likely cause: "), ai.likelyCause),
    h("p", {}, h("strong", {}, "Suggested fix: "), ai.suggestedFix),
  );
}

function precedentBlock(f) {
  if (!f.precedent) return null;
  const p = f.precedent;
  const aiLine = f.ai?.status === "ok" ? f.ai.precedentSuggestion : null;
  return h(
    "div",
    { class: "block precedent" },
    h("span", { class: "tag" }, aiLine ? "Seen before · AI suggestion" : "Seen before"),
    h("p", {}, aiLine ?? p.summary),
    aiLine
      ? h(
          "p",
          { class: "source" },
          `From the record: ${p.invoiceId} (${p.period}), ${p.status} by ${p.decidedBy} on ${when(p.decidedAt)}${p.note ? `, note: “${p.note.replace(/[.\s]+$/, "")}”` : ""}. Advisory only; you decide.`,
        )
      : null,
  );
}

/**
 * open -> Resolved or Escalated; escalated -> Resolved only; resolved is final and read-only.
 * The server enforces the same rules; this just doesn't offer what it would refuse.
 */
function decisionArea(f) {
  const decided = f.decidedBy ? `${STATUS_LABEL[f.status]} by ${f.decidedBy} on ${when(f.decidedAt)}` : "";
  if (f.status === "resolved") {
    return h("div", { class: "decision final" }, h("p", { class: "state" }, `${decided}.`), f.note ? h("p", { class: "final-note" }, f.note) : null);
  }

  const state = h(
    "p",
    { class: "state" },
    f.status === "open" ? "Open: no decision recorded yet." : `${decided}${f.note ? `: “${f.note}”` : "."}`,
  );
  const msg = h("p", { class: "msg", role: "alert" });
  const note = h("textarea", {
    rows: "1",
    maxlength: "1000",
    placeholder: f.status === "escalated" ? "Resolution note, required (what was done)" : "Note, required (what you did and why)",
    "aria-label": `Note for ${f.id}`,
    required: true,
    oninput: (ev) => (f.draft = ev.target.value), // survives re-renders from filtering or other decisions
  });
  note.value = f.draft ?? "";

  const decide = async (status, button) => {
    msg.textContent = "";
    const analyst = analystName; // always a valid, non-blank name
    if (!note.value.trim()) {
      msg.textContent =
        status === "resolved" ? "Add a note before you resolve: what was done to fix it." : "Add a note before you escalate: why it needs escalating.";
      note.focus();
      return;
    }
    button.disabled = true;
    try {
      const { issue } = await api(`/api/customers/${encodeURIComponent(f.customerId)}/decisions`, {
        method: "POST",
        body: JSON.stringify({ issueKey: f.id, status, note: note.value, analyst }),
      });
      // Keep the in-memory result current, then re-render so the card moves to its new place.
      Object.assign(f, { status: issue.status, note: issue.note, decidedBy: issue.decidedBy, decidedAt: issue.decidedAt, draft: "" });
      setStatus(
        status === "resolved"
          ? `${capitalize(f.label)} on ${f.invoiceId} resolved. It moved to the Resolved list.`
          : `${capitalize(f.label)} on ${f.invoiceId} escalated. It stays in Needs review until resolved.`,
      );
      renderLists();
      markTour("decide");
      loadInsights(current); // metrics only; the summary keeps its "Refresh" link
    } catch (e) {
      msg.textContent = `${capitalize(e.message)}${/[.!?]$/.test(e.message) ? "" : "."}`;
      button.disabled = false;
    }
  };

  const resolve = h("button", { type: "button", onclick: () => decide("resolved", resolve) }, "Resolve");
  const escalate =
    f.status === "open" ? h("button", { type: "button", onclick: () => decide("escalated", escalate) }, "Escalate") : null;
  return h("div", { class: `decision${escalate ? "" : " one"}` }, state, note, resolve, escalate, msg);
}

function invoiceTable(invoices) {
  const showCase = invoices.some((inv) => inv.plantedCase);
  return h(
    "div",
    { class: "card table-wrap" },
    h(
      "table",
      {},
      h(
        "thead",
        {},
        h(
          "tr",
          {},
          h("th", {}, "Invoice"),
          h("th", {}, "Customer"),
          h("th", {}, "Status"),
          showCase ? h("th", {}, "Planted case") : null,
          h("th", { class: "num" }, "Expected"),
          h("th", { class: "num" }, "Invoiced"),
          h("th", { class: "num" }, "Difference"),
        ),
      ),
      h(
        "tbody",
        {},
        invoices.map((inv) =>
          h(
            "tr",
            {},
            h("td", {}, inv.invoiceId),
            h("td", {}, customerButton(inv.customerId)),
            h("td", {}, h("span", { class: `badge ${inv.status}` }, STATUS_LABEL[inv.status])),
            showCase ? h("td", { class: "case" }, inv.plantedCase ? `${inv.plantedCase.number}. ${inv.plantedCase.title}` : "") : null,
            h("td", { class: "num" }, money(inv.expectedTotalCents)),
            h("td", { class: "num" }, money(inv.invoicedTotalCents)),
            h("td", { class: "num" }, inv.differenceCents ? signed(inv.differenceCents) : "—"),
          ),
        ),
      ),
    ),
  );
}

// ---------- per-customer history ----------

const dialog = $("#history");

async function openHistory(customerId) {
  const body = $("#history-body");
  $("#history-title").textContent = `History: ${customerId}`;
  body.replaceChildren(h("p", { class: "meta" }, "Loading…"));
  if (!dialog.open) dialog.showModal();
  markTour("history");
  try {
    const { issues, events } = await api(`/api/customers/${encodeURIComponent(customerId)}/history`);
    const byKey = Object.fromEntries(issues.map((i) => [i.key, i]));
    body.replaceChildren(
      h("h3", {}, "Issues"),
      issues.length
        ? h(
            "div",
            { class: "table-wrap" },
            h(
              "table",
              {},
              h(
                "thead",
                {},
                h("tr", {}, h("th", {}, "Period"), h("th", {}, "Invoice"), h("th", {}, "Issue"), h("th", { class: "num" }, "Difference"), h("th", {}, "Status"), h("th", {}, "Decision")),
              ),
              h(
                "tbody",
                {},
                issues.map((i) =>
                  h(
                    "tr",
                    {},
                    h("td", {}, i.period),
                    h("td", {}, i.invoiceId),
                    h("td", {}, capitalize(i.label ?? i.type)),
                    h("td", { class: "num" }, signed(i.differenceCents)),
                    h("td", {}, h("span", { class: `badge ${i.status}` }, STATUS_LABEL[i.status])),
                    h("td", {}, i.decidedBy ? `${i.decidedBy}${i.note ? `: ${i.note}` : ""}` : "—"),
                  ),
                ),
              ),
            ),
          )
        : h("p", { class: "meta" }, "No issues recorded for this customer."),
      h("h3", {}, "Audit trail"),
      events.length
        ? h(
            "ol",
            { class: "events" },
            events.map((e) =>
              h(
                "li",
                {},
                h("time", { datetime: e.at }, when(e.at)),
                h("strong", {}, e.actor),
                ` ${e.action} ${byKey[e.issueKey]?.invoiceId ?? e.issueKey}`,
                e.note ? `: “${e.note}”` : "",
              ),
            ),
          )
        : h("p", { class: "meta" }, "No events yet."),
    );
  } catch (e) {
    body.replaceChildren(h("p", { class: "status error" }, e.message));
  }
}

function capitalize(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
