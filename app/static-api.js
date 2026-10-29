/* Phone and web version: answers the app's /api/ calls in the browser from data.json, which a
   daily job publishes. Each person's profile, checklist ticks and saved items stay in this browser.
   Loaded only by the exported site (see hrc/webexport.py); the desktop app never loads this file. */
(function () {
  "use strict";
  window.HRC_STATIC = true;
  document.documentElement.classList.add("static");

  const KEY = "hrc:";
  const store = {
    get(k, d) { try { const v = localStorage.getItem(KEY + k); return v === null ? d : JSON.parse(v); } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem(KEY + k, JSON.stringify(v)); } catch (_) { /* private mode: not saved */ } },
  };

  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  let DATA = null;
  const ready = fetch("data.json", {cache: "no-cache"}).then(r => r.json()).then(d => {
    DATA = d;
    DATA.byId = new Map(d.items.map(i => [i.id, i]));
    for (const i of d.items) {
      i._title = norm(i.title);
      i._summary = norm(i.summary);
      i._body = norm(i.body);
      i._other = norm([i.citation, i.agency, i.category].join(" "));
    }
    return d;
  });

  /* ---------- helpers ---------- */
  function norm(s) { return (s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim(); }
  const today = () => new Date().toISOString().slice(0, 10);
  const addDays = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  const lawDate = i => i.enacted_date || i.effective_date || i.published_date || "";
  function stem(w) {  // rough stand-in for the desktop app's stemming
    if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
    if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3);
    if (w.length > 4 && w.endsWith("es")) return w.slice(0, -2);
    if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
    if (w.length > 4 && w.endsWith("ed")) return w.slice(0, -2);
    return w;
  }
  function parseQuery(q) {
    const terms = [], phrases = [];
    (q || "").split('"').forEach((part, i) => {
      const n = norm(part);
      if (!n) return;
      if (i % 2) phrases.push(n); else n.split(" ").forEach(w => terms.push(stem(w)));
    });
    return {terms, phrases};
  }
  const hasPrefix = (text, t) => (" " + text).includes(" " + t);
  function score(i, {terms, phrases}) {
    const fields = [[i._title, 10], [i._summary, 4], [i._body, 1], [i._other, 3]];
    let total = 0;
    for (const t of terms) {
      let s = 0;
      for (const [text, w] of fields) if (hasPrefix(text, t)) s += w;
      if (!s) return 0;
      total += s;
    }
    for (const p of phrases) {
      let s = 0;
      for (const [text, w] of fields) if ((" " + text + " ").includes(" " + p + " ")) s += w * 2;
      if (!s) return 0;
      total += s;
    }
    return total;
  }
  function snippet(i, {terms, phrases}) {
    const text = (i.body || i.summary || "").replace(/\s+/g, " ");
    const low = text.toLowerCase();
    const words = phrases.concat(terms).filter(Boolean);
    let at = -1;
    for (const w of words) { const k = low.indexOf(w); if (k >= 0 && (at < 0 || k < at)) at = k; }
    if (at < 0) return "";
    const a = Math.max(0, at - 90), b = Math.min(text.length, at + 160);
    let out = (a ? "… " : "") + text.slice(a, b) + (b < text.length ? " …" : "");
    for (const w of words) {
      const re = new RegExp("(^|[^\\p{L}\\p{N}])(" + w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[\\p{L}\\p{N}]*)", "giu");
      out = out.replace(re, "$1[[$2]]");
    }
    return out;
  }
  function saved() { return store.get("bookmarks", {}); }
  function withMine(i) {
    const b = saved()[i.id];
    return Object.assign({}, i, {law_date: lawDate(i), saved: b ? 1 : 0, bookmark_note: b ? b.note || "" : ""});
  }

  /* ---------- the API ---------- */
  function search(p) {
    const q = parseQuery(p.get("q"));
    const searching = q.terms.length || q.phrases.length;
    let codes = (p.get("states") || "").split(",").filter(Boolean).map(s => s.toUpperCase());
    if (!codes.length && p.get("state")) codes = [p.get("state").toUpperCase()];
    if (codes.length && p.get("federal") === "1" && !codes.includes("US")) codes.push("US");
    const since = p.get("days") ? addDays(-+p.get("days")) : "";
    const employees = +p.get("employees") || 0;
    const marks = saved();
    let rows = [];
    for (const i of DATA.items) {
      if (codes.length && !codes.includes(i.jurisdiction)) continue;
      if (p.get("category") && i.category !== p.get("category")) continue;
      if (p.get("type") && i.item_type !== p.get("type")) continue;
      if (since && !((i.last_changed || "") >= since && i.last_changed > i.first_seen)) continue;
      if (employees && i.min_employees && i.min_employees > employees) continue;
      if (p.get("saved") === "1" && !marks[i.id]) continue;
      let s = 1;
      if (searching && !(s = score(i, q))) continue;
      rows.push([s, i]);
    }
    const sort = p.get("sort");
    const typeRank = t => (t === "State Requirement" || t === "AI Summary") ? 0 : t === "Law" ? 1 : 2;
    const stateFirst = codes.length && !(codes.length === 1 && codes[0] === "US");
    if (sort === "date") rows.sort((a, b) => (lawDate(b[1]) || "").localeCompare(lawDate(a[1]) || "") || a[1].title.localeCompare(b[1].title));
    else if (sort === "changed") rows.sort((a, b) => (b[1].last_changed || "").localeCompare(a[1].last_changed || ""));
    else if (searching) rows.sort((a, b) => b[0] - a[0]);
    else rows.sort((a, b) => (stateFirst ? (a[1].jurisdiction === "US") - (b[1].jurisdiction === "US") : 0)
      || typeRank(a[1].item_type) - typeRank(b[1].item_type) || a[1].jurisdiction.localeCompare(b[1].jurisdiction)
      || (lawDate(b[1]) || "").localeCompare(lawDate(a[1]) || "") || a[1].title.localeCompare(b[1].title));
    const limit = +p.get("limit") || 25, offset = +p.get("offset") || 0;
    const page = rows.slice(offset, offset + limit).map(([, i]) => {
      const r = withMine(i);
      delete r.body; delete r.facts; delete r.history;
      r.snippet = searching ? snippet(i, q) : "";
      return r;
    });
    return {total: rows.length, results: page, _all: rows.map(([, i]) => i)};
  }

  function upcoming(p) {
    const codes = (p.get("states") || "").split(",").filter(Boolean).map(s => s.toUpperCase()).concat("US");
    const from = today(), until = addDays(+p.get("days") || 180), out = [];
    for (const i of DATA.items) {
      if (!codes.includes(i.jurisdiction)) continue;
      const base = {id: i.id, title: i.title, jurisdiction: i.jurisdiction, item_type: i.item_type, category: i.category, url: i.url};
      if (i.effective_date >= from && i.effective_date <= until) out.push(Object.assign({kind: "effective", due: i.effective_date}, base));
      if (i.comments_close_date >= from && i.comments_close_date <= until) out.push(Object.assign({kind: "comments", due: i.comments_close_date}, base));
    }
    return out.sort((a, b) => a.due.localeCompare(b.due));
  }

  function changes(p) {
    let codes = (p.get("states") || "").split(",").filter(Boolean).map(s => s.toUpperCase());
    if (!codes.length && p.get("state")) codes = [p.get("state").toUpperCase()];
    if (codes.length) codes.push("US");
    const since = p.get("since") || (p.get("days") ? new Date(Date.now() - p.get("days") * 864e5).toISOString() : "");
    return DATA.changes.filter(c => (!codes.length || codes.includes(c.jurisdiction)) && (!since || c.changed_at >= since))
      .slice(0, +p.get("limit") || 50);
  }

  function profile() { return store.get("profile", {states: [], employees: null, company: ""}); }

  function checklist() {
    const prof = profile(), n = prof.employees || 0, done = store.get("checklist_done", {});
    const now = today(), year = +now.slice(0, 4), items = [];
    const pad = x => String(x).padStart(2, "0");
    function add(group, e, yearly) {
      const when = done[e.cid] || "";
      let due = "", prev = "";
      if (e.due) {
        due = `${year}-${pad(e.due[0])}-${pad(e.due[1])}`;
        if (due < now) due = `${year + 1}-${pad(e.due[0])}-${pad(e.due[1])}`;
        prev = `${+due.slice(0, 4) - 1}${due.slice(4)}`;
      }
      const isDone = yearly && when ? when > (prev || `${year - 1}-12-31`) : !!when;
      items.push({id: e.cid, group, text: e.text, detail: e.detail || "", url: e.url || "", item_id: e.item_id || null,
                  yearly: !!yearly, due, done: isDone, done_at: isDone ? when : ""});
    }
    const short = t => t.split(" (")[0].split(":")[0];
    const laws = DATA.items.filter(i => i.jurisdiction === "US" && i.item_type === "Law" && (!n || !i.min_employees || i.min_employees <= n))
      .sort((a, b) => a.title.localeCompare(b.title));
    const posters = new Map();
    for (const l of laws) if (l.poster_url) { if (!posters.has(l.poster_url)) posters.set(l.poster_url, []); posters.get(l.poster_url).push(l); }
    for (const [url, group] of posters) {
      const names = group.map(l => short(l.title)).join(", ");
      if (url.includes("eeoc.gov/poster"))
        add("Posters to display", {cid: "poster:eeoc", text: '"Know Your Rights: Workplace Discrimination is Illegal" (EEOC)', detail: `Covers ${names}.`, url, item_id: group[0].id});
      else add("Posters to display", {cid: "poster:" + group[0].uid, text: `${names} poster`, url, item_id: group[0].id});
    }
    for (const l of laws) if (l.recordkeeping)
      add("Records to keep (confirm your retention policy covers these)", {cid: "records:" + l.uid, text: `${short(l.title)}: ${l.recordkeeping}`, url: l.url, item_id: l.id});
    for (const e of DATA.checklist.always_yearly) add("Yearly deadlines", e, true);
    for (const e of DATA.checklist.yearly) if (n >= e.min_employees) add("Yearly deadlines", e, true);
    for (const code of prof.states || []) for (const e of DATA.checklist.states[code] || []) add(e.group, e, false);
    return items;
  }

  function item(id) {
    const i = DATA.byId.get(+id);
    if (!i) return {error: "not found"};
    return Object.assign(withMine(i), {history: i.history || [], facts: i.facts || {}});
  }

  function csv(rows) {
    const cols = ["jurisdiction", "title", "item_type", "category", "status", "citation", "agency", "enacted_date", "effective_date",
                  "published_date", "comments_close_date", "coverage", "url", "bookmark_note", "first_seen", "last_changed"];
    const cell = v => { v = v == null ? "" : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    return "\ufeff" + [cols.join(",")].concat(rows.map(r => cols.map(c => cell(withMine(r)[c])).join(","))).join("\r\n");
  }

  function ics(p) {
    const esc = t => (t || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
    const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
    const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//HR Compliance Tracker//EN", "CALSCALE:GREGORIAN"];
    const ev = (due, title, url, uid, yearly) => lines.push("BEGIN:VEVENT", `UID:${uid}@hr-compliance-tracker`, `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${due.replace(/-/g, "").slice(0, 8)}`, `SUMMARY:${esc(title.slice(0, 200))}`, `DESCRIPTION:${esc(url)}`,
      ...(yearly ? ["RRULE:FREQ=YEARLY"] : []), "END:VEVENT");
    for (const u of upcoming(new URLSearchParams({states: p.get("states") || "", days: "365"})))
      ev(u.due, (u.kind === "comments" ? "Comments due: " : "Takes effect: ") + u.title, u.url || "", `u${u.id}${u.kind}`, false);
    for (const c of checklist()) if (c.due) ev(c.due, c.text, c.url, "c" + c.id.replace(/[^a-z0-9]/gi, ""), true);
    lines.push("END:VCALENDAR");
    return lines.join("\r\n") + "\r\n";
  }

  function route(method, path, params, body) {
    if (method === "GET") {
      if (path === "/api/meta") return Object.assign({}, DATA.meta, {reviewed_at: store.get("reviewed_at", "")});
      if (path === "/api/search") { const r = search(params); delete r._all; return r; }
      if (path === "/api/compare") return (params.get("states") || "").split(",").map(s => DATA.compare[s.toUpperCase()]).filter(Boolean);
      if (path === "/api/upcoming") return upcoming(params);
      if (path === "/api/changes") return changes(params);
      if (path === "/api/profile") return profile();
      if (path === "/api/checklist") return checklist();
      if (path.startsWith("/api/item/")) return item(path.split("/").pop());
      if (path === "/api/watch") return [];
    }
    if (method === "POST") {
      if (path === "/api/profile") {
        const prof = {states: (body.states || []).map(s => s.toUpperCase()).filter(s => DATA.meta.states[s]),
                      employees: /^\d+$/.test(String(body.employees || "")) ? +body.employees : null,
                      company: String(body.company || "").slice(0, 200)};
        store.set("profile", prof);
        return prof;
      }
      if (path === "/api/checklist") {
        const d = store.get("checklist_done", {});
        if (body.done) d[body.id] = today(); else delete d[body.id];
        store.set("checklist_done", d);
        return {status: "ok"};
      }
      if (path === "/api/bookmark") {
        const b = saved();
        if (body.remove) delete b[body.id]; else b[body.id] = {note: body.note != null ? body.note : (b[body.id] || {}).note || ""};
        store.set("bookmarks", b);
        return {status: "ok"};
      }
      if (path === "/api/reviewed") { const t = new Date().toISOString().slice(0, 19) + "+00:00"; store.set("reviewed_at", t); return {reviewed_at: t}; }
      if (path === "/api/refresh") return {status: "The data is refreshed automatically every day."};
    }
    return {error: "Not available in the phone and web version"};
  }

  const realFetch = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    const url = new URL(typeof input === "string" ? input : input.url, location.href);
    const at = url.pathname.indexOf("/api/");
    if (at < 0) return realFetch(input, init);
    await ready;
    const method = ((init && init.method) || "GET").toUpperCase();
    let body = {};
    try { body = init && init.body ? JSON.parse(init.body) : {}; } catch (_) { body = {}; }
    const out = route(method, url.pathname.slice(at), url.searchParams, body);
    return new Response(JSON.stringify(out), {status: out && out.error === "not found" ? 404 : 200, headers: {"Content-Type": "application/json"}});
  };

  /* Downloads (CSV export, calendar) are made in the browser. */
  window.HRC_DOWNLOAD = async function (href) {
    await ready;
    const url = new URL(href, location.href), path = url.pathname.slice(url.pathname.indexOf("/api/"));
    let text, name, type;
    if (path === "/api/export.csv") { text = csv(search(new URLSearchParams(Object.assign(Object.fromEntries(url.searchParams), {limit: 5000})))._all); name = "hr-compliance-export.csv"; type = "text/csv"; }
    else if (path === "/api/upcoming.ics") { text = ics(url.searchParams); name = "hr-compliance-dates.ics"; type = "text/calendar"; }
    else return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], {type: type + ";charset=utf-8"}));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  };
})();
