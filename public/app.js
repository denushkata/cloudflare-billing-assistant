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

try {
  analystEl.value = localStorage.getItem("analyst") ?? "";
} catch {}
analystEl.addEventListener("change", () => {
  try {
    localStorage.setItem("analyst", analystEl.value.trim());
  } catch {}
});

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

$("#upload-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const form = new FormData(ev.target);
  const files = {};
  for (const name of ["usage", "invoices", "plans", "creditMemos"]) {
    const file = form.get(name);
    if (file && file.size) files[name] = await file.text();
  }
  if (!files.usage || !files.invoices) {
    setStatus("Choose at least usage.csv and invoices.csv.", { error: true });
    return;
  }
  run({ files }, "Your files");
});

$("#reset").addEventListener("click", async () => {
  if (!confirm("Clear all decisions on the sample customers and restore the demo history?")) return;
  setBusy(true);
  try {
    await api("/api/demo/reset", { method: "POST", body: "{}" });
    resultsEl.replaceChildren();
    setStatus("Demo history reset. Click “Load sample data” to run it again.");
  } catch (e) {
    setStatus(e.message, { error: true });
  } finally {
    setBusy(false);
  }
});

// ---------- results ----------

function renderResults(data) {
  const findings = data.invoices.flatMap((inv) => inv.findings);
  const errors = findings.filter((f) => f.severity === "error");
  const explained = findings.filter((f) => f.severity === "explained");
  const aiOk = findings.filter((f) => f.ai?.status === "ok").length;
  const sourceNote = Object.values(data.sources).includes("uploaded")
    ? ` · files: ${Object.entries(data.sources).map(([k, v]) => `${k} ${v}`).join(", ")}`
    : "";

  resultsEl.replaceChildren(
    h(
      "section",
      { "aria-label": "Summary" },
      h(
        "div",
        { class: "tiles" },
        tile(data.counts.invoices, "Invoices checked", ""),
        tile(data.counts.flagged, "Flagged", "flagged"),
        tile(data.counts.explained, "Explained", "explained"),
        tile(data.counts.clean, "Clean", "clean"),
      ),
      h(
        "p",
        { class: "meta" },
        `Period ${data.period.join(", ")} · ${aiOk} of ${findings.length} explanations from ${data.ai.model.split("/").pop()} · ${(data.durationMs / 1000).toFixed(1)}s${sourceNote}`,
      ),
      data.warnings.map((w) => h("p", { class: "warn" }, w)),
    ),
    errors.length
      ? section("Needs review", `${errors.length} issue${errors.length === 1 ? "" : "s"}. Record a decision on each.`, errors.map(findingCard))
      : section("Needs review", "", [h("p", { class: "no-action" }, "No errors found.")]),
    explained.length ? section("Explained", "Looks different, but is correct.", explained.map(findingCard)) : null,
    section("All invoices", "Totals include tax and approved credits.", [invoiceTable(data.invoices)]),
  );
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
    ),
    h(
      "dl",
      { class: "amounts" },
      amount("Expected", money(f.expectedCents)),
      amount("Invoiced", money(f.invoicedCents)),
      amount("Difference", signed(f.differenceCents), direction(f.differenceCents)),
    ),
    h("div", { class: "block" }, h("span", { class: "tag" }, "Calculated"), h("p", {}, f.summary)),
    aiBlock(f.ai),
    precedentBlock(f),
    f.severity === "error" ? decisionForm(f, badge) : h("p", { class: "no-action" }, "No action needed: the invoice is correct."),
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

function decisionForm(f, badge) {
  const state = h("p", { class: "state" });
  const msg = h("p", { class: "msg", role: "alert" });
  const note = h("textarea", { rows: "1", maxlength: "1000", placeholder: "Note (what you did and why)", "aria-label": `Note for ${f.id}` });
  note.value = f.note ?? "";

  const showState = (issue) => {
    state.textContent =
      issue.status === "open"
        ? "Open: no decision recorded yet."
        : `${STATUS_LABEL[issue.status]} by ${issue.decidedBy} on ${when(issue.decidedAt)}.`;
    badge.className = `badge ${issue.status}`;
    badge.textContent = STATUS_LABEL[issue.status];
  };

  const decide = async (status, button) => {
    msg.textContent = "";
    const analyst = analystEl.value.trim();
    if (!analyst) {
      msg.textContent = "Enter your name at the top of the page first; it goes in the audit trail.";
      analystEl.focus();
      return;
    }
    button.disabled = true;
    try {
      const { issue } = await api(`/api/customers/${encodeURIComponent(f.customerId)}/decisions`, {
        method: "POST",
        body: JSON.stringify({ issueKey: f.id, status, note: note.value, analyst }),
      });
      showState(issue);
    } catch (e) {
      msg.textContent = e.message;
    } finally {
      button.disabled = false;
    }
  };

  const resolve = h("button", { type: "button", onclick: () => decide("resolved", resolve) }, "Resolved");
  const escalate = h("button", { type: "button", onclick: () => decide("escalated", escalate) }, "Escalated");
  showState(f);
  return h("div", { class: "decision" }, state, note, resolve, escalate, msg);
}

function invoiceTable(invoices) {
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
dialog.querySelector("[data-close]").addEventListener("click", () => dialog.close());
dialog.addEventListener("click", (ev) => {
  if (ev.target === dialog) dialog.close();
});

async function openHistory(customerId) {
  const body = $("#history-body");
  $("#history-title").textContent = `History: ${customerId}`;
  body.replaceChildren(h("p", { class: "meta" }, "Loading…"));
  if (!dialog.open) dialog.showModal();
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
