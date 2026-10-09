/* MyAssistant Admin — single-page app. No framework, no build step.
 * All user-sourced strings go through textContent (never innerHTML). */
"use strict";

const API = "/admin-panel/api";
const $app = document.getElementById("app");
const $tip = document.getElementById("tooltip");

/* ------------------------------------------------------------------ */
/* Utilities                                                           */
/* ------------------------------------------------------------------ */

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on") && typeof v === "function") {
      el.addEventListener(k.slice(2), v);
    } else if (k === "value") el.value = v;
    else if (k === "checked") el.checked = Boolean(v);
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    credentials: "same-origin",
    headers: { "X-Admin-Panel": "1", ...(opts.body ? { "Content-Type": "application/json" } : {}) },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) {
    showLogin();
    throw new Error("signed out");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/**
 * A FILE UPLOAD. api() JSON-encodes every body, so a file needs its own
 * path: multipart FormData over XHR, because fetch cannot report upload
 * progress and a 300 MB clip on hotel wi-fi needs a moving number.
 * The browser sets the multipart boundary; no Content-Type here.
 */
function upload(path, form, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", API + path);
    xhr.withCredentials = true;
    xhr.setRequestHeader("X-Admin-Panel", "1");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded, e.total);
    };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText || "{}"); } catch (_) {}
      if (xhr.status === 401) { showLogin(); return reject(new Error("signed out")); }
      if (xhr.status < 200 || xhr.status >= 300) {
        return reject(new Error(data.error || `HTTP ${xhr.status}`));
      }
      resolve(data);
    };
    xhr.onerror = () => reject(new Error("the upload was cut off — check the connection and try again"));
    xhr.send(form);
  });
}

const fmtDate = (ms) => {
  const t = parseInt(ms, 10);
  if (!Number.isFinite(t) || !t) return "—";
  return new Date(t).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
};
const timeAgo = (ms) => {
  const d = Date.now() - parseInt(ms, 10);
  if (!Number.isFinite(d) || d < 0) return "";
  const m = Math.floor(d / 60000);
  if (m < 1) return "just now";
  if (m < 60) return m + "m ago";
  const hr = Math.floor(m / 60);
  if (hr < 24) return hr + "h ago";
  return Math.floor(hr / 24) + "d ago";
};
const fmtUptime = (s) => {
  if (s < 3600) return Math.floor(s / 60) + "m";
  if (s < 86400) return Math.floor(s / 3600) + "h " + Math.floor((s % 3600) / 60) + "m";
  return Math.floor(s / 86400) + "d " + Math.floor((s % 86400) / 3600) + "h";
};
const dayLabel = (iso) => {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
};

let toastTimer = null;
function toast(msg, isError) {
  document.querySelectorAll(".toast").forEach((t) => t.remove());
  const el = h("div", { class: "toast" + (isError ? " error" : "") }, msg);
  document.body.append(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 3500);
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/* ------------------------------------------------------------------ */
/* Charts (single series, one hue, hover tooltips)                     */
/* ------------------------------------------------------------------ */

const SVGNS = "http://www.w3.org/2000/svg";
function svgEl(tag, attrs) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
  return el;
}

function niceCeil(n) {
  if (n <= 5) return Math.max(n, 1);
  const pow = Math.pow(10, Math.floor(Math.log10(n)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * pow >= n) return m * pow;
  return n;
}

function showTip(ev, label, value) {
  $tip.replaceChildren(
    h("span", { class: "t-label" }, label + "  "),
    h("strong", {}, String(value))
  );
  $tip.hidden = false;
  const pad = 12;
  $tip.style.left = Math.min(ev.clientX + pad, window.innerWidth - 160) + "px";
  $tip.style.top = ev.clientY - 34 + "px";
}
const hideTip = () => { $tip.hidden = true; };

/** Vertical bar chart of [{d:'YYYY-MM-DD', count}] */
function barChart(series) {
  if (!series || !series.length) return h("div", { class: "chart-empty" }, "No data yet.");
  const W = 640, H = 150, padL = 34, padB = 20, padT = 8;
  const plotW = W - padL - 6, plotH = H - padB - padT;
  const max = niceCeil(Math.max(1, ...series.map((s) => s.count)));
  const n = series.length;
  const gap = Math.max(2, Math.floor(plotW / n / 6));
  const bw = Math.max(3, Math.floor(plotW / n) - gap);

  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}` });
  // grid: 0 / half / max
  for (const frac of [0, 0.5, 1]) {
    const y = padT + plotH - frac * plotH;
    svg.append(svgEl("line", { class: "grid-line", x1: padL, y1: y, x2: W - 4, y2: y }));
    const lbl = svgEl("text", { class: "axis", x: padL - 6, y: y + 4, "text-anchor": "end" });
    lbl.textContent = String(Math.round(frac * max));
    svg.append(lbl);
  }
  series.forEach((s, i) => {
    const x = padL + i * (plotW / n) + gap / 2;
    const bh = Math.max(s.count > 0 ? 3 : 1, (s.count / max) * plotH);
    const y = padT + plotH - bh;
    const r = svgEl("rect", {
      x, y, width: bw, height: bh, rx: 2,
      class: s.count > 0 ? "bar" : "bar zero",
    });
    r.addEventListener("mousemove", (ev) => showTip(ev, dayLabel(s.d), s.count));
    r.addEventListener("mouseleave", hideTip);
    svg.append(r);
  });
  // sparse x labels: first, middle, last
  for (const i of [0, Math.floor(n / 2), n - 1]) {
    const x = padL + i * (plotW / n) + bw / 2;
    const t = svgEl("text", { class: "axis", x, y: H - 5, "text-anchor": "middle" });
    t.textContent = dayLabel(series[i].d);
    svg.append(t);
  }
  return h("div", { class: "chart-wrap" }, svg);
}

/** Horizontal labelled bars for [{label, count}] */
function hbarList(items) {
  if (!items || !items.length) return h("div", { class: "chart-empty" }, "No data yet.");
  const max = Math.max(...items.map((i) => parseInt(i.count, 10)), 1);
  return h("div", {}, items.map((it) =>
    h("div", { class: "hbar-row" },
      h("span", { class: "lbl", title: it.label }, it.label),
      h("div", { class: "hbar-track" },
        h("div", { class: "hbar-fill", style: `width:${(parseInt(it.count, 10) / max) * 100}%` })),
      h("span", { class: "val" }, String(it.count))
    )
  ));
}

/* ------------------------------------------------------------------ */
/* Login                                                               */
/* ------------------------------------------------------------------ */

function showLogin() {
  const err = h("div", { class: "login-error" });
  const input = h("input", { class: "input", type: "password", placeholder: "Enter the admin key", autocomplete: "current-password" });
  const btn = h("button", { class: "btn primary", style: "width:100%; margin-top:6px; justify-content:center;" }, "Sign in");
  const submit = async () => {
    err.textContent = "";
    btn.disabled = true;
    try {
      await api("/login", { method: "POST", body: { key: input.value } });
      location.hash = "#/";
      render();
    } catch (e) {
      err.textContent = e.message;
    }
    btn.disabled = false;
  };
  btn.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
  $app.replaceChildren(
    h("div", { class: "login-wrap" },
      h("div", { class: "login-card" },
        h("div", { class: "brand-mark" }, "M"),
        h("h1", {}, "MyAssistant Admin"),
        h("div", { class: "sub" }, "Sign in with the administrator key."),
        h("div", { class: "field" }, h("label", {}, "Admin key"), input),
        btn, err
      )
    )
  );
  input.focus();
}

/* ------------------------------------------------------------------ */
/* Shell + router                                                      */
/* ------------------------------------------------------------------ */

/* Icons: 24-unit strokes, currentColor. */
const ICONS = {
  grid: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  pulse: "M3 12h4l3-8 4 16 3-8h4",
  chart: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  users: "M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 10a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM22 19v-1a4 4 0 0 0-3-3.9M16 3.1a3.5 3.5 0 0 1 0 6.8",
  phone: "M7 2h10a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zM11 18h2",
  inbox: "M22 12h-6l-2 3h-4l-2-3H2M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z",
  chat: "M21 12a8 8 0 0 1-11.8 7L3 21l2-6.2A8 8 0 1 1 21 12z",
  mic: "M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM19 11a7 7 0 0 1-14 0M12 18v4",
  file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6",
  video: "M23 7l-7 5 7 5zM1 5h15v14H1z",
  list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  check: "M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11",
  bell: "M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0",
  flag: "M4 22V4M4 15s1-1 4-1 5 2 8 2 4-1 4-1V4s-1 1-4 1-5-2-8-2-4 1-4 1",
  cpu: "M6 6h12v12H6zM9 9h6v6H9zM9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3",
  sun: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4",
  moon: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z",
  logout: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9",
  refresh: "M23 4v6h-6M1 20v-6h6M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15",
  info: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01",
  user: "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
};
function icon(name) {
  const s = svgEl("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 1.8, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" });
  s.append(svgEl("path", { d: ICONS[name] || ICONS.grid }));
  return s;
}

/* Theme: system, light or dark; remembered per browser. */
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch (_) { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (_) {} },
};
function applyTheme() {
  const t = store.get("adm-theme", "system");
  if (t === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
}
function isDark() {
  const t = document.documentElement.getAttribute("data-theme");
  return t ? t === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
}
applyTheme();

const NAV = [
  ["Overview", [["#/", "Dashboard", "grid"], ["#/live", "Live", "pulse"], ["#/analytics", "Analytics", "chart"]]],
  ["People", [["#/users", "Users", "users"], ["#/phones", "Phones", "phone"], ["#/feedback", "Feedback", "inbox"]]],
  ["Content", [["#/conversations", "Conversations", "chat"], ["#/recordings", "Recordings", "mic"],
    ["#/documents", "Documents", "file"], ["#/video-notes", "Video notes", "video"]]],
  ["Operations", [["#/activity", "Activity", "list"], ["#/outcomes", "Task outcomes", "check"],
    ["#/broadcast", "Notifications", "bell"], ["#/flags", "Feature flags", "flag"], ["#/debug", "System & debug", "cpu"]]],
];
const NAV_FLAT = NAV.flatMap(([, items]) => items);

function shell(activeHash, content) {
  const nav = NAV.flatMap(([group, items]) => [
    h("div", { class: "nav-group" }, group),
    ...items.map(([hash, label, ic]) =>
      h("button", {
        class: "nav-item" + (hash === activeHash ? " active" : ""),
        onclick: () => { location.hash = hash; },
      }, icon(ic), label)),
  ]);
  const themeBtn = h("button", {
    class: "icon-btn", title: "Switch light / dark",
    onclick: () => {
      store.set("adm-theme", isDark() ? "light" : "dark");
      applyTheme();
      themeBtn.replaceChildren(icon(isDark() ? "sun" : "moon"));
    },
  }, icon(isDark() ? "sun" : "moon"));
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || "");
  $app.replaceChildren(
    h("div", { class: "shell" },
      h("aside", { class: "sidebar" },
        h("div", { class: "brand" }, h("div", { class: "brand-mark" }, "M"), h("span", {}, "MyAssistant")),
        h("button", { class: "search-trigger", onclick: openPalette },
          icon("search"), "Search…", h("kbd", {}, mac ? "⌘K" : "Ctrl K")),
        ...nav,
        h("div", { class: "spacer" }),
        h("div", { class: "sidebar-foot" },
          h("button", {
            class: "nav-item", onclick: async () => {
              try { await api("/logout", { method: "POST" }); } catch (_) {}
              showLogin();
            },
          }, icon("logout"), "Sign out"),
          themeBtn)
      ),
      h("main", { class: "main" }, content)
    )
  );
}

/* ⌘K: jump to any page or user. */
function openPalette() {
  if (document.querySelector(".palette-back")) return;
  const input = h("input", { placeholder: "Jump to a page or find a user…", autocomplete: "off" });
  const list = h("div", { class: "palette-list" });
  let items = [];
  let sel = 0;
  let users = [];
  const close = () => back.remove();
  const go = (it) => { close(); location.hash = it.hash; };
  function draw() {
    const q = input.value.trim().toLowerCase();
    const pages = NAV_FLAT.filter(([, label]) => !q || label.toLowerCase().includes(q))
      .map(([hash, label, ic]) => ({ hash, label, ic, sub: "Page" }));
    const people = users.map((u) => ({
      hash: "#/user/" + u.id, label: u.name || u.email || "#" + u.id, ic: "user",
      sub: "#" + u.id + (u.phone_number ? " · " + u.phone_number : ""),
    }));
    items = [...pages, ...people];
    sel = Math.min(sel, Math.max(0, items.length - 1));
    const row = (it, i) => h("div", {
      class: "palette-item" + (i === sel ? " on" : ""),
      onmouseenter: () => { sel = i; draw(); },
      onclick: () => go(it),
    }, icon(it.ic), it.label, h("span", { class: "sub" }, it.sub));
    list.replaceChildren(
      pages.length ? h("div", { class: "palette-sec" }, "Pages") : null,
      ...pages.map((it, i) => row(it, i)),
      people.length ? h("div", { class: "palette-sec" }, "Users") : null,
      ...people.map((it, i) => row(it, pages.length + i)),
      items.length ? null : h("div", { class: "chart-empty" }, "Nothing matches."));
  }
  const findUsers = debounce(async () => {
    const q = input.value.trim();
    if (q.length < 2) { users = []; return draw(); }
    try { users = (await api("/users?limit=8&q=" + encodeURIComponent(q))).users || []; } catch (_) { users = []; }
    draw();
  }, 180);
  input.addEventListener("input", () => { sel = 0; draw(); findUsers(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { sel = Math.min(items.length - 1, sel + 1); draw(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { sel = Math.max(0, sel - 1); draw(); e.preventDefault(); }
    else if (e.key === "Enter" && items[sel]) go(items[sel]);
    else if (e.key === "Escape") close();
  });
  const back = h("div", { class: "palette-back", onclick: (e) => { if (e.target === back) close(); } },
    h("div", { class: "palette" }, input, list));
  document.body.append(back);
  draw();
  input.focus();
}
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    if (document.querySelector(".login-wrap")) return;
    e.preventDefault();
    openPalette();
  }
});

function pageHead(title, sub, ...actions) {
  return h("div", { class: "page-head" },
    h("div", {}, h("div", { class: "page-title" }, title),
      sub ? h("div", { class: "page-sub" }, sub) : null),
    actions.length ? h("div", { style: "display:flex; gap:8px;" }, actions) : null
  );
}

const loading = () => h("div", { class: "muted", style: "padding:40px 0;" }, "Loading…");

async function render() {
  const hash = location.hash || "#/";
  const userMatch = hash.match(/^#\/user\/(\d+)/);
  try {
    if (userMatch) return await viewUserDetail(parseInt(userMatch[1], 10));
    if (hash.startsWith("#/live")) return await viewLive();
    if (hash.startsWith("#/users")) return await viewUsers();
    if (hash.startsWith("#/analytics")) return await viewAnalytics();
    if (hash.startsWith("#/conversations")) return await viewConversations();
    if (hash.startsWith("#/recordings")) return await viewRecordings();
    if (hash.startsWith("#/phones")) return await viewPhones();
    if (hash.startsWith("#/video-notes")) return await viewVideoNotes();
    if (hash.startsWith("#/documents")) return await viewDocuments();
    if (hash.startsWith("#/activity")) return await viewActivity();
    if (hash.startsWith("#/feedback")) return await viewFeedback();
    if (hash.startsWith("#/outcomes")) return await viewOutcomes();
    if (hash.startsWith("#/broadcast")) return await viewBroadcast();
    if (hash.startsWith("#/flags")) return await viewFlags();
    if (hash.startsWith("#/debug")) return await viewDebug();
    return await viewOverview();
  } catch (e) {
    if (e.message !== "signed out") toast(e.message, true);
  }
}

/* ------------------------------------------------------------------ */
/* Overview                                                            */
/* ------------------------------------------------------------------ */

function kpi(label, value, delta) {
  return h("div", { class: "kpi" },
    h("div", { class: "label" }, label),
    h("div", { class: "value num" }, String(value)),
    delta ? h("div", { class: "delta" }, delta) : null);
}

/* ------------------------------------------------------------------ */
/* Dashboard (2026-10-09): usage, people, spend                        */
/* ------------------------------------------------------------------ */

const FEATURE_LABEL = {
  chat: "Assistant replies", search: "Web search", transcribe: "Speech to text",
  speech: "Spoken replies", image: "Images", embed: "Memory", voice_session: "Voice sessions",
  phone_call: "Phone calls (Bolna)", other: "Other",
};
const featureLabel = (f) => FEATURE_LABEL[f] || f;

/** Money in the chosen currency: $ or ₹ (rate from the server). */
let usdInr = 88;
const currency = () => store.get("adm-currency", "usd");
function money(usd, { precise = false } = {}) {
  const v = Number(usd) || 0;
  if (currency() === "inr") {
    const r = v * usdInr;
    return "₹" + (r < 10 && precise ? r.toFixed(2) : r < 100 ? r.toFixed(r < 10 ? 2 : 1) : Math.round(r).toLocaleString("en-IN"));
  }
  if (v === 0) return "$0";
  if (v < 0.01) return "$" + v.toFixed(4);
  if (v < 100) return "$" + v.toFixed(2);
  return "$" + Math.round(v).toLocaleString("en-US");
}
const compact = (n) => {
  const v = Number(n) || 0;
  if (v >= 1e6) return (v / 1e6).toFixed(v >= 1e7 ? 0 : 1) + "M";
  if (v >= 1e4) return (v / 1e3).toFixed(0) + "k";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "k";
  return String(Math.round(v));
};

/** "+12%" against the period before, coloured; spend going up is not "good". */
function trend(cur, prev, { neutral = false } = {}) {
  if (!prev && !cur) return h("span", { class: "trend flat" }, "—");
  if (!prev) return h("span", { class: "trend " + (neutral ? "flat" : "up") }, "new");
  const pct = ((cur - prev) / prev) * 100;
  const cls = Math.abs(pct) < 0.5 ? "flat" : neutral ? "flat" : pct > 0 ? "up" : "down";
  return h("span", { class: "trend " + cls, title: "vs the previous period" },
    (pct > 0 ? "↑ " : pct < 0 ? "↓ " : "") + Math.abs(pct).toFixed(Math.abs(pct) < 10 ? 1 : 0) + "%");
}

function showTipRows(ev, head, rows) {
  $tip.replaceChildren(
    h("div", { class: "t-head" }, head),
    ...rows.map(([cls, label, value]) =>
      h("div", { class: "t-row" }, cls ? h("span", { class: "sw " + cls }) : null, label, h("b", {}, value))));
  $tip.hidden = false;
  const r = $tip.getBoundingClientRect();
  let x = ev.clientX + 14;
  if (x + r.width > window.innerWidth - 8) x = ev.clientX - r.width - 14;
  $tip.style.left = x + "px";
  $tip.style.top = Math.max(8, ev.clientY - r.height - 10) + "px";
}

/** Tiny trend line for a KPI card. */
function sparkline(values) {
  const W = 120, H = 30;
  const svg = svgEl("svg", { class: "spark", viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none" });
  if (!values.length || values.every((v) => !v)) return svg;
  const max = Math.max(...values, 1);
  const pts = values.map((v, i) => [values.length === 1 ? W / 2 : (i / (values.length - 1)) * W, H - 2 - (v / max) * (H - 4)]);
  const d = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join("");
  svg.append(svgEl("path", { class: "area", d: d + `L${W} ${H}L0 ${H}Z` }));
  svg.append(svgEl("path", { class: "line", d, "vector-effect": "non-scaling-stroke" }));
  return svg;
}

/**
 * Lines over days. series: [{d, k1, k2…}]; keys: [{key, label, cls}].
 * Hover anywhere shows every value for that day.
 */
function lineChart(series, keys, { fmt = (v) => String(v), height = 220, area = true, width = 720 } = {}) {
  if (!series.length) return h("div", { class: "chart-empty" }, "No data yet.");
  const W = width, H = height, padL = 40, padR = 8, padT = 10, padB = 22;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const max = niceCeil(Math.max(1e-9, ...series.flatMap((s) => keys.map((k) => Number(s[k.key]) || 0))));
  const n = series.length;
  const X = (i) => padL + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const Y = (v) => padT + plotH - (v / max) * plotH;
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}` });
  for (const f of [0, 0.25, 0.5, 0.75, 1]) {
    const y = padT + plotH - f * plotH;
    svg.append(svgEl("line", { class: "grid-line", x1: padL, y1: y, x2: W - padR, y2: y }));
    const t = svgEl("text", { class: "axis", x: padL - 8, y: y + 3, "text-anchor": "end" });
    t.textContent = fmt(f * max, true);
    svg.append(t);
  }
  const ticks = Math.min(n, 6);
  for (let j = 0; j < ticks; j++) {
    const i = Math.round((j / Math.max(1, ticks - 1)) * (n - 1));
    const t = svgEl("text", { class: "axis", x: X(i), y: H - 5, "text-anchor": j === 0 ? "start" : j === ticks - 1 ? "end" : "middle" });
    t.textContent = dayLabel(series[i].d);
    svg.append(t);
  }
  for (const k of keys) {
    const g = svgEl("g", { class: k.cls });
    const d = series.map((s, i) => (i ? "L" : "M") + X(i).toFixed(1) + " " + Y(Number(s[k.key]) || 0).toFixed(1)).join("");
    if (area) g.append(svgEl("path", { class: "area", d: d + `L${X(n - 1)} ${padT + plotH}L${X(0)} ${padT + plotH}Z` }));
    g.append(svgEl("path", { class: "line", d }));
    svg.append(g);
  }
  const cross = svgEl("line", { class: "cross", x1: 0, x2: 0, y1: padT, y2: padT + plotH, visibility: "hidden" });
  svg.append(cross);
  const dots = keys.map((k) => { const c = svgEl("circle", { class: "dot", r: 3.5, visibility: "hidden" }); const g = svgEl("g", { class: k.cls }); g.append(c); svg.append(g); return c; });
  const hit = svgEl("rect", { class: "hit", x: padL, y: padT, width: plotW, height: plotH });
  hit.addEventListener("mousemove", (ev) => {
    const box = svg.getBoundingClientRect();
    const sx = ((ev.clientX - box.left) / box.width) * W;
    const i = Math.max(0, Math.min(n - 1, Math.round(((sx - padL) / plotW) * (n - 1))));
    cross.setAttribute("x1", X(i)); cross.setAttribute("x2", X(i)); cross.setAttribute("visibility", "visible");
    keys.forEach((k, j) => {
      dots[j].setAttribute("cx", X(i)); dots[j].setAttribute("cy", Y(Number(series[i][k.key]) || 0));
      dots[j].setAttribute("visibility", "visible");
    });
    showTipRows(ev, dayLabel(series[i].d), keys.map((k) => [k.cls, k.label, fmt(Number(series[i][k.key]) || 0)]));
  });
  hit.addEventListener("mouseleave", () => {
    hideTip(); cross.setAttribute("visibility", "hidden");
    dots.forEach((d) => d.setAttribute("visibility", "hidden"));
  });
  svg.append(hit);
  return h("div", { class: "chart-wrap" }, svg);
}

/** Stacked bars over days. series: [{d, k1, k2…}]; keys: [{key, label, cls}]. */
function stackedBars(series, keys, { fmt = (v) => String(v), height = 230, width = 1160 } = {}) {
  if (!series.length) return h("div", { class: "chart-empty" }, "No data yet.");
  const W = width, H = height, padL = 44, padR = 4, padT = 10, padB = 22;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const tot = (s) => keys.reduce((a, k) => a + (Number(s[k.key]) || 0), 0);
  const max = niceCeil(Math.max(1e-9, ...series.map(tot)));
  const n = series.length;
  const slot = plotW / n;
  const bw = Math.max(2, slot * 0.68);
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}` });
  for (const f of [0, 0.5, 1]) {
    const y = padT + plotH - f * plotH;
    svg.append(svgEl("line", { class: "grid-line", x1: padL, y1: y, x2: W - padR, y2: y }));
    const t = svgEl("text", { class: "axis", x: padL - 8, y: y + 3, "text-anchor": "end" });
    t.textContent = fmt(f * max, true);
    svg.append(t);
  }
  series.forEach((s, i) => {
    const x = padL + i * slot + (slot - bw) / 2;
    let y = padT + plotH;
    const g = svgEl("g", {});
    if (!tot(s)) g.append(svgEl("rect", { class: "bar zero", x, y: y - 1, width: bw, height: 1 }));
    for (const k of keys) {
      const v = Number(s[k.key]) || 0;
      if (!v) continue;
      const bh = Math.max(1.5, (v / max) * plotH);
      y -= bh;
      const wrap = svgEl("g", { class: k.cls });
      wrap.append(svgEl("rect", { class: "seg-fill", x, y, width: bw, height: bh, rx: 1.5 }));
      g.append(wrap);
    }
    const hit = svgEl("rect", { class: "hit", x: padL + i * slot, y: padT, width: slot, height: plotH });
    hit.addEventListener("mousemove", (ev) => showTipRows(ev, dayLabel(s.d),
      [...keys.filter((k) => Number(s[k.key])).map((k) => [k.cls, k.label, fmt(Number(s[k.key]))]), [null, "Total", fmt(tot(s))]]));
    hit.addEventListener("mouseleave", hideTip);
    g.append(hit);
    svg.append(g);
  });
  const ticks = Math.min(n, 6);
  for (let j = 0; j < ticks; j++) {
    const i = Math.round((j / Math.max(1, ticks - 1)) * (n - 1));
    const t = svgEl("text", { class: "axis", x: padL + i * slot + slot / 2, y: H - 5, "text-anchor": "middle" });
    t.textContent = dayLabel(series[i].d);
    svg.append(t);
  }
  return h("div", { class: "chart-wrap" }, svg);
}

const legend = (keys) => h("div", { class: "legend" },
  keys.map((k) => h("span", {}, h("span", { class: "sw " + k.cls }), k.label)));

function heatmap(rows) {
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const r of rows || []) grid[r.dow][r.hr] = r.n;
  const max = Math.max(1, ...grid.flat());
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const order = [1, 2, 3, 4, 5, 6, 0];
  const cells = [];
  for (const dw of order) {
    cells.push(h("div", { class: "hl" }, days[dw]));
    for (let hr = 0; hr < 24; hr++) {
      const v = grid[dw][hr];
      const a = v ? 0.15 + 0.85 * (v / max) : 0;
      const c = h("div", { class: "hc", style: v ? `background: color-mix(in srgb, var(--accent) ${Math.round(a * 100)}%, transparent)` : "" });
      c.addEventListener("mousemove", (ev) => showTipRows(ev, `${days[dw]} ${String(hr).padStart(2, "0")}:00–${String((hr + 1) % 24).padStart(2, "0")}:00`, [[null, "Messages", String(v)]]));
      c.addEventListener("mouseleave", hideTip);
      cells.push(c);
    }
  }
  cells.push(h("div", {}));
  for (let hr = 0; hr < 24; hr++) cells.push(h("div", { class: "hx" }, hr % 6 === 0 ? String(hr) : ""));
  return h("div", { class: "heat" }, cells);
}

function funnel(f) {
  const steps = [
    ["Signed up", f.signed_up], ["Verified phone", f.verified],
    ["Talked to her", f.talked], ["Active last 7 days", f.active7],
  ];
  const top = Math.max(1, Number(f.signed_up) || 0);
  return h("div", {}, steps.map(([label, v]) => {
    const n = Number(v) || 0;
    return h("div", { class: "funnel-row" },
      h("span", { class: "lbl" }, label),
      h("div", { class: "funnel-track" }, h("div", { class: "funnel-fill", style: `width:${(n / top) * 100}%` })),
      h("span", { class: "val" }, String(n), h("small", {}, Math.round((n / top) * 100) + "%")));
  }));
}

const SERIES_CLS = ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"];

function kpiCard(label, value, { cur, prev, neutral, spark, sub } = {}) {
  return h("div", { class: "kpi" },
    h("div", { class: "label" }, label),
    h("div", { class: "row" },
      h("div", { class: "value num" }, value),
      prev !== undefined ? trend(cur, prev, { neutral }) : null),
    sub ? h("div", { class: "delta" }, sub) : null,
    spark ? sparkline(spark) : null);
}

/** The people table: sortable, filterable, spend as a bar. */
function topUsersTable(rows) {
  let sortKey = "activity";
  let dir = -1;
  let q = "";
  let all = false;
  const maxUsd = Math.max(1e-9, ...rows.map((r) => r.usd));
  const cols = [
    ["#", null, ""], ["User", "name", ""], ["Days active", "days", "r"], ["Conversations", "turns", "r"],
    ["Voice", "voice", "r"], ["Actions", "actions", "r"], ["Calls", "calls", "r"], ["Spend", "usd", "r"], ["Last active", "last_active", "r"],
  ];
  const wrap = h("div", {});
  const val = (r, k) => (k === "activity" ? r.turns + r.actions : k === "name" ? String(r.name || r.email || "").toLowerCase() : Number(r[k]) || 0);
  function draw() {
    const list = rows
      .filter((r) => !q || String(r.name || "").toLowerCase().includes(q) || String(r.email || "").toLowerCase().includes(q) || String(r.user_id) === q)
      .sort((a, b) => (val(a, sortKey) > val(b, sortKey) ? dir : val(a, sortKey) < val(b, sortKey) ? -dir : 0));
    const hidden = all || q ? 0 : Math.max(0, list.length - 12);
    if (hidden) list.length = 12;
    wrap.replaceChildren(h("table", {},
      h("thead", {}, h("tr", {}, cols.map(([label, key, cls]) => h("th", {
        class: [cls, key ? "sortable" : "", key === sortKey ? "sorted" : ""].join(" "),
        onclick: key ? () => { if (sortKey === key) dir = -dir; else { sortKey = key; dir = key === "name" ? 1 : -1; } draw(); } : null,
      }, label, key === sortKey ? (dir < 0 ? " ↓" : " ↑") : "")))),
      h("tbody", {}, list.length ? list.map((r, i) => h("tr", { class: "rowlink", onclick: () => { location.hash = "#/user/" + r.user_id; } },
        h("td", { class: "rank" }, String(i + 1)),
        h("td", {}, h("div", { style: "display:flex; align-items:center; gap:10px; min-width:180px;" },
          h("span", { class: "avatar" }, initialsOf(r)),
          h("div", { style: "min-width:0;" },
            h("div", { style: "font-weight:500;" }, r.name || "No name"),
            h("div", { class: "sub" }, "#" + r.user_id + (r.app_build ? " · build " + r.app_build : "") + (r.status === "paused" ? " · paused" : ""))))),
        h("td", { class: "r num" }, String(r.days)),
        h("td", { class: "r num" }, compact(r.turns)),
        h("td", { class: "r num" }, r.turns ? Math.round((r.voice / r.turns) * 100) + "%" : "—"),
        h("td", { class: "r num" }, compact(r.actions)),
        h("td", { class: "r num" }, r.calls ? String(r.calls) : h("span", { class: "faint" }, "—")),
        h("td", { class: "r" }, h("div", { class: "cell-bar" },
          h("span", { class: "num" }, money(r.usd)),
          h("div", { class: "meter" }, h("div", { style: `width:${(r.usd / maxUsd) * 100}%` })))),
        h("td", { class: "r sub" }, r.last_active ? timeAgo(r.last_active) : "—")))
        : h("tr", {}, h("td", { colspan: cols.length, class: "chart-empty" }, "Nobody used the app in this period.")))),
      hidden ? h("button", { class: "show-more", onclick: () => { all = true; draw(); } }, `Show ${hidden} more`) : null);
  }
  const search = h("input", { class: "input", style: "max-width:220px;", placeholder: "Filter people…", oninput: (e) => { q = e.target.value.trim().toLowerCase(); draw(); } });
  draw();
  return { search, wrap };
}

let dashDays = Number(store.get("adm-days", "30")) || 30;

async function viewOverview() {
  shell("#/", h("div", {}, pageHead("Dashboard", "Loading…"),
    h("div", { class: "grid kpis-hero" }, [1, 2, 3, 4].map(() => h("div", { class: "kpi skel", style: "height:104px;" }))),
    h("div", { class: "card skel section-gap", style: "height:300px;" })));
  const [d, o] = await Promise.all([api("/dashboard?days=" + dashDays), api("/overview").catch(() => null)]);
  usdInr = d.usdInr || usdInr;
  const k = d.kpis;
  const updated = new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });

  const rangeSeg = h("div", { class: "seg" }, [7, 14, 30, 90].map((n) =>
    h("button", { class: n === dashDays ? "on" : "", onclick: () => { dashDays = n; store.set("adm-days", String(n)); viewOverview().catch((e) => toast(e.message, true)); } }, n + "d")));
  const curSeg = h("div", { class: "seg", title: `₹ at ${usdInr} per $` }, [["usd", "$"], ["inr", "₹"]].map(([c, l]) =>
    h("button", { class: c === currency() ? "on" : "", onclick: () => { store.set("adm-currency", c); viewOverview().catch((e) => toast(e.message, true)); } }, l)));
  const refresh = h("button", { class: "btn sm", title: "Refresh", onclick: () => viewOverview().catch((e) => toast(e.message, true)) }, icon("refresh"), updated);

  const fmtMoneyAxis = (v) => money(v);
  const features = d.series.features.length ? d.series.features : [];
  const fkeys = features.map((f, i) => ({ key: f, label: featureLabel(f), cls: SERIES_CLS[i % SERIES_CLS.length] }));

  // Usage chart with a switch between people and conversations.
  const usageBody = h("div", {});
  let usageMode = "active";
  const drawUsage = () => {
    usageBody.replaceChildren(usageMode === "active"
      ? lineChart(d.series.active.map((x) => ({ d: x.d, v: x.count })), [{ key: "v", label: "Active users", cls: "s1" }])
      : h("div", {},
          lineChart(d.series.turns, [{ key: "voice", label: "Voice", cls: "s1" }, { key: "other", label: "Typed & other", cls: "s2" }]),
          h("div", { style: "margin-top:8px;" }, legend([{ cls: "s1", label: "Voice" }, { cls: "s2", label: "Typed & other" }]))));
    usageSeg.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.m === usageMode));
  };
  const usageSeg = h("div", { class: "seg" }, [["active", "Active users"], ["turns", "Conversations"]].map(([m, l]) =>
    h("button", { "data-m": m, onclick: () => { usageMode = m; drawUsage(); } }, l)));
  drawUsage();

  const totalFeat = d.spendByFeature.reduce((a, f) => a + f.usd, 0) || 1e-9;
  const people = topUsersTable(d.topUsers);
  const notices = [];
  if (!d.meterSince || Date.now() - d.meterSince < 3 * 86400_000) {
    notices.push(h("div", { class: "notice" }, icon("info"),
      h("div", {}, h("b", {}, "Spend tracking is new. "),
        d.meterSince ? "It started " + timeAgo(d.meterSince) + ", so earlier days show nothing yet." : "It starts with this release; numbers fill in as people use the app.")));
  }
  if (!d.billed) {
    notices.push(h("div", { class: "notice" }, icon("info"),
      h("div", {}, "Spend is estimated from the server's own calls at list prices. The phone's live voice talks to OpenAI directly, so it is counted as sessions, not dollars. Set ",
        h("code", {}, "OPENAI_ADMIN_KEY"), " to show OpenAI's actual bill here as well.")));
  }

  const spendByDay = d.series.spend;
  const billedByDay = d.billed ? Object.fromEntries(d.billed.days.map((x) => [x.d, x.usd])) : null;

  shell("#/", h("div", {},
    pageHead("Dashboard", `Last ${d.days} days · India time`, rangeSeg, curSeg, refresh),
    ...notices,
    h("div", { class: "grid kpis-hero" },
      kpiCard("Active users", compact(k.active), { cur: k.active, prev: k.activePrev, spark: d.series.active.map((x) => x.count), sub: `of ${k.users} total` }),
      kpiCard("Conversations", compact(k.turns), { cur: k.turns, prev: k.turnsPrev, spark: d.series.turns.map((x) => x.voice + x.other), sub: k.active ? (k.turns / k.active).toFixed(1) + " per active user" : "" }),
      kpiCard("Spend", money(k.spend), { cur: k.spend, prev: k.spendPrev, neutral: true, spark: spendByDay.map((x) => x.total), sub: money(k.spendToday, { precise: true }) + " today" }),
      kpiCard(d.billed ? "OpenAI bill" : "Cost per active user", d.billed ? money(d.billed.total) : money(k.costPerActive, { precise: true }),
        d.billed ? { sub: "actual, incl. phone voice", spark: d.billed.days.map((x) => x.usd) } : { sub: "server-side estimate" })),
    h("div", { class: "strip section-gap" },
      ...[["Today", k.dau], ["This week", k.wau], ["This month", k.mau],
        ["Stickiness", Math.round(k.stickiness * 100) + "%"], ["New signups", k.signups],
        ["Voice sessions", compact(k.voiceSessions)], ["Phone calls", k.calls + (k.callMinutes ? ` · ${k.callMinutes}m` : "")]]
        .map(([kk, v]) => h("div", {}, h("div", { class: "k" }, kk), h("div", { class: "v" }, String(v))))),
    h("div", { class: "grid dash-main section-gap" },
      h("div", { class: "card" }, h("div", { class: "card-head" }, h("h3", {}, "Usage"), usageSeg), usageBody),
      h("div", { class: "card" },
        h("div", { class: "card-head" }, h("h3", {}, "Where the money goes"), h("span", { class: "hint" }, money(k.spend))),
        d.spendByFeature.length
          ? h("div", {}, d.spendByFeature.map((f, i) => h("div", { class: "hbar-row" },
              h("span", { class: "lbl", title: `${f.n} calls` }, h("span", { class: "sw " + (fkeys.find((x) => x.key === f.feature)?.cls || SERIES_CLS[i % SERIES_CLS.length]) }), featureLabel(f.feature)),
              h("div", { class: "hbar-track" }, h("div", { class: "hbar-fill", style: `width:${(f.usd / totalFeat) * 100}%` })),
              h("span", { class: "val" }, money(f.usd)))))
          : h("div", { class: "chart-empty" }, "No paid calls recorded yet."))),
    h("div", { class: "card section-gap" },
      h("div", { class: "card-head" }, h("h3", {}, "Spend per day ", h("span", { class: "hint" }, "by feature")), fkeys.length ? legend(fkeys) : null),
      fkeys.length
        ? stackedBars(spendByDay, fkeys, { fmt: fmtMoneyAxis })
        : h("div", { class: "chart-empty" }, "Nothing spent in this period."),
      billedByDay ? h("div", { class: "section-gap" },
        h("h3", {}, "OpenAI's own bill per day ", h("span", { class: "hint" }, "includes the phone's live voice")),
        lineChart(spendByDay.map((x) => ({ d: x.d, billed: billedByDay[x.d] || 0, metered: x.total })),
          [{ key: "billed", label: "Billed by OpenAI", cls: "s4" }, { key: "metered", label: "Metered here", cls: "s1" }],
          { fmt: fmtMoneyAxis, height: 200, width: 1160 })) : null),
    h("div", { class: "card table-card section-gap" },
      h("div", { class: "card-head", style: "padding:10px 12px 2px;" },
        h("h3", {}, "People ", h("span", { class: "hint" }, "who uses it most, and what they cost")), people.search),
      people.wrap),
    h("div", { class: "grid two-col section-gap" },
      h("div", { class: "card" }, h("h3", {}, "When people talk to her ", h("span", { class: "hint" }, "messages by hour, India time")), heatmap(d.heat)),
      h("div", { class: "card" }, h("h3", {}, "From signup to habit"), funnel(d.funnel),
        h("h3", { class: "section-gap" }, "App versions in use"),
        hbarList((d.versions || []).map((v) => ({ label: v.build ? "build " + v.build : "unknown", count: v.users }))))),
    h("div", { class: "grid two-col section-gap" },
      h("div", { class: "card table-card" },
        h("h3", { style: "padding:10px 12px 0;" }, "Spend by model"),
        h("table", {},
          h("thead", {}, h("tr", {}, h("th", {}, "Model"), h("th", { class: "r" }, "Calls"), h("th", { class: "r" }, "Tokens in"), h("th", { class: "r" }, "Cached"), h("th", { class: "r" }, "Tokens out"), h("th", { class: "r" }, "Cost"))),
          h("tbody", {}, d.spendByModel.length ? d.spendByModel.map((m) => h("tr", {},
            h("td", {}, h("span", { class: "mono", style: "font-size:12px;" }, m.model || m.provider)),
            h("td", { class: "r num" }, compact(m.n)),
            h("td", { class: "r num" }, compact(m.tin)),
            h("td", { class: "r num" }, m.tin ? Math.round((m.tcached / m.tin) * 100) + "%" : "—"),
            h("td", { class: "r num" }, compact(m.tout)),
            h("td", { class: "r num" }, money(m.usd))))
            : h("tr", {}, h("td", { colspan: 6, class: "chart-empty" }, "No paid calls recorded yet."))))),
      h("div", { class: "card" },
        h("h3", {}, "How people reach her ", h("span", { class: "hint" }, "replies by surface")),
        hbarList((d.sources || []).map((s) => ({ label: s.source, count: s.n }))))),
    o ? h("div", { class: "grid three-col section-gap" },
      h("div", { class: "card" },
        h("h3", {}, "Latest activity ", h("span", { class: "hint" }, "audit trail")),
        ...(o.activity.length ? o.activity.slice(0, 10).map((x) => h("div", { class: "feed-item" },
          h("div", { class: "feed-dot" }),
          h("div", {},
            h("div", {}, h("span", { class: "who" }, x.name || "someone"), h("span", { class: "what" }, " · " + x.action)),
            h("div", { class: "when" }, (x.detail ? x.detail + " — " : "") + timeAgo(x.created_at)))))
          : [h("div", { class: "chart-empty" }, "No activity recorded yet.")])),
      h("div", {},
        h("div", { class: "card" },
          h("h3", {}, "Feature adoption"),
          ...[["Documents saved", o.adoption.docs], ["Open reminders", o.adoption.reminders], ["Open promises", o.adoption.commitsOpen],
            ["Client case files", o.adoption.clients], ["Messages relayed", o.adoption.agentMsgs], ["Memories stored", o.adoption.memories],
            ["Finance items", o.adoption.financeItems], ["Verified phones", o.kpis.verified], ["Devices with push", o.kpis.devices]]
            .map(([kk, v]) => h("div", { class: "stat-mini" }, h("span", { class: "k" }, kk), h("span", { class: "v" }, String(v))))),
        h("div", { class: "card section-gap" },
          h("h3", {}, "Server"),
          ...[["Database", o.health.dbMs + " ms"], ["Uptime", fmtUptime(o.health.uptimeS)], ["Memory", o.health.rssMb + " MB"], ["Node", o.health.node]]
            .map(([kk, v]) => h("div", { class: "stat-mini" }, h("span", { class: "k" }, kk), h("span", { class: "v" }, v)))))) : null
  ));
}

/** One user's spend, on their detail page. */
function spendCard(id) {
  const body = h("div", { class: "chart-empty" }, "Loading…");
  const head = h("span", { class: "hint" }, "");
  const card = h("div", { class: "card" }, h("div", { class: "card-head" }, h("h3", {}, "Spend · last 30 days"), head), body);
  api("/users/" + id + "/spend").then((s) => {
    head.textContent = money(s.total30) + " · " + money(s.allTime) + " all time";
    const total = s.byFeature.reduce((a, f) => a + f.usd, 0) || 1e-9;
    body.replaceWith(h("div", {},
      lineChart(s.daily.map((x) => ({ d: x.d, v: x.count })), [{ key: "v", label: "Spend", cls: "s1" }], { fmt: (v) => money(v), height: 150 }),
      s.byFeature.length ? h("div", { class: "section-gap" }, s.byFeature.map((f) => h("div", { class: "hbar-row" },
        h("span", { class: "lbl", title: f.n + " calls" }, featureLabel(f.feature)),
        h("div", { class: "hbar-track" }, h("div", { class: "hbar-fill", style: `width:${(f.usd / total) * 100}%` })),
        h("span", { class: "val" }, money(f.usd))))) : h("div", { class: "chart-empty" }, "No paid calls for this user yet.")));
  }).catch((e) => { body.textContent = e.message; });
  return card;
}

/* ------------------------------------------------------------------ */
/* Users                                                               */
/* ------------------------------------------------------------------ */

function statusBadge(u) {
  return u.status === "paused"
    ? h("span", { class: "badge warn" }, "Paused")
    : h("span", { class: "badge good" }, "Active");
}
function initialsOf(u) {
  return (u.name || u.email || "?").split(/\s+/).map((x) => x[0]).join("").toUpperCase().slice(0, 2);
}

async function viewUsers() {
  shell("#/users", loading());
  let q = "";
  const tableWrap = h("div", { class: "card table-card" }, loading());
  const sub = h("div", { class: "page-sub" }, "");

  async function load() {
    const d = await api("/users?q=" + encodeURIComponent(q));
    sub.textContent = d.total + " account" + (d.total === 1 ? "" : "s");
    const rows = d.users.map((u) =>
      h("tr", { class: "rowlink", onclick: () => { location.hash = "#/user/" + u.id; } },
        h("td", {}, h("div", { style: "display:flex; align-items:center; gap:10px;" },
          h("span", { class: "avatar" }, initialsOf(u)),
          h("div", {}, h("div", { style: "font-weight:600;" }, u.name || "No name"),
            h("div", { class: "sub" }, "#" + u.id + (u.email ? " · " + u.email : ""))))),
        h("td", {}, u.phone_number
          ? h("span", {}, u.phone_number, " ",
              u.phone_verified_at ? h("span", { class: "badge good" }, "verified")
                                  : h("span", { class: "badge warn" }, "unverified"))
          : h("span", { class: "faint" }, "—")),
        h("td", {}, h("span", { class: "badge neutral" }, u.provider || "?")),
        h("td", {},
          h("div", {}, u.has_device ? h("span", { class: "badge accent" }, "push ok")
                                    : h("span", { class: "faint" }, "no device")),
          u.device_model ? h("div", { class: "sub", style: "margin-top:4px;" }, u.device_model,
            u.device_os ? h("span", { class: "faint" }, " · " + u.device_os) : null) : null),
        h("td", {}, u.app_build
          ? h("span", { class: "badge neutral" }, "build " + u.app_build)
          : h("span", { class: "faint" }, "unknown")),
        h("td", {}, statusBadge(u)),
        h("td", { class: "sub" }, u.last_seen_at ? timeAgo(u.last_seen_at) : fmtDate(u.created_at))
      ));
    tableWrap.replaceChildren(
      h("table", {},
        h("thead", {}, h("tr", {},
          h("th", {}, "User"), h("th", {}, "Phone"), h("th", {}, "Provider"),
          h("th", {}, "Device"), h("th", {}, "App version"), h("th", {}, "Status"),
          h("th", {}, "Last seen"))),
        h("tbody", {}, rows.length ? rows
          : h("tr", {}, h("td", { colspan: 7, class: "chart-empty" }, "No users match."))))
    );
  }

  const search = h("input", {
    class: "input", style: "max-width:280px;", placeholder: "Search name, email, phone, id…",
    oninput: debounce((e) => { q = e.target.value.trim(); load().catch((x) => toast(x.message, true)); }, 300),
  });

  shell("#/users", h("div", {},
    h("div", { class: "page-head" },
      h("div", {}, h("div", { class: "page-title" }, "Users"), sub), search),
    tableWrap));
  await load();
}

/* ------------------------------------------------------------------ */
/* User detail                                                         */
/* ------------------------------------------------------------------ */

/** A user's own recent exchanges, shown inside their detail page. */
function conversationCard(rows, userId) {
  if (!rows || !rows.length) {
    return h("div", { class: "card" }, h("h3", {}, "Recent conversation"),
      h("div", { class: "chart-empty" }, "No conversations recorded yet."),
      userId ? h("div", { style: "padding:0 12px 12px;" },
        h("a", { class: "btn", href: "#/recordings/" + userId }, "Listen")) : null);
  }
  return h("div", { class: "card table-card" },
    h("div", {
      style: "display:flex; align-items:center; gap:10px; padding:10px 12px 0;",
    },
      h("h3", { style: "margin:0;" }, "Recent conversation"),
      h("div", { style: "flex:1;" }),
      // The transcript is here; the audio behind it is one click away.
      userId ? h("a", { class: "btn", href: "#/recordings/" + userId }, "Listen") : null,
      userId ? h("button", {
        class: "btn",
        onclick: () => window.open(
          `/admin-panel/api/conversations.csv?user_id=${userId}&limit=2000`, "_blank"),
      }, "Download CSV") : null),
    h("table", {},
      h("thead", {}, h("tr", {}, h("th", {}, "When"), h("th", {}, "Question"),
        h("th", {}, "Answer"), h("th", {}, "Reply time"))),
      h("tbody", {}, rows.map((c) =>
        h("tr", {},
          h("td", { class: "sub", style: "white-space:nowrap;" }, timeAgo(c.created_at)),
          h("td", { style: "max-width:240px;" }, c.question || h("span", { class: "faint" }, "—")),
          h("td", { class: "sub", style: "max-width:340px;" }, c.answer || ""),
          h("td", {}, latencyPill(c.latency_ms)))))));
}

/** SELF-CHECKS (2026-10-09): what the phone itself found, check by check, with its log. */
function selfCheckCard(id) {
  const body = h("div", {}, loading());
  const status = h("span", { class: "sub" }, "");
  const ask = h("button", { class: "btn", onclick: async () => {
    try {
      await api("/users/" + id + "/diagnostics/request", { method: "POST" });
      toast("Asked. It runs the next time they open the app or come back to it.");
      load();
    } catch (e) { toast(e.message, true); }
  } }, "Request self-check");
  const when = (ms) => new Date(Number(ms)).toLocaleString();
  async function load() {
    try {
      const d = await api("/users/" + id + "/diagnostics");
      const r = d.request;
      status.textContent = r && Number(r.done_at) === 0 ? `Requested ${timeAgo(r.requested_at)} — waiting for the phone` : "";
      if (!d.reports.length) { body.replaceChildren(h("div", { class: "chart-empty" }, "No self-checks yet.")); return; }
      body.replaceChildren(...d.reports.map((rep, i) => {
        const log = h("pre", { style: "display:none; max-height:360px; overflow:auto; white-space:pre-wrap; font-size:12px;" },
          rep.readable ? (rep.log || "(empty)") : "(hidden: Help improve is off)");
        return h("div", { style: "border-top:1px solid var(--line, #8883); padding:10px 0;" },
          h("div", { style: "display:flex; gap:8px; align-items:center; flex-wrap:wrap;" },
            h("strong", {}, when(rep.ran_at || rep.created_at)),
            h("span", { class: "badge " + (Number(rep.failed) ? "danger" : "good") }, Number(rep.failed) ? `${rep.failed} failed` : "all passed"),
            h("span", { class: "sub" }, rep.trigger || ""),
            h("button", { class: "btn", style: "margin-left:auto;", onclick: () => {
              log.style.display = log.style.display === "none" ? "block" : "none"; } }, "App log")),
          h("table", { class: "table", style: "margin-top:6px;" },
            h("tbody", {}, ...rep.checks.map((c) => h("tr", {},
              h("td", { style: "width:28px;" }, c.ok === true ? "✅" : c.ok === false ? "❌" : "ℹ️"),
              h("td", { style: "white-space:nowrap;" }, c.name),
              h("td", {}, c.detail))))),
          log);
      }));
    } catch (e) { body.replaceChildren(h("div", { class: "chart-empty" }, e.message)); }
  }
  load();
  return h("div", { class: "card" },
    h("div", { style: "display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-bottom:6px;" },
      h("h3", { style: "margin:0;" }, "Self-checks from the phone"), status, h("span", { style: "flex:1" }), ask),
    body);
}

async function viewUserDetail(id) {
  shell("#/users", loading());
  const d = await api("/users/" + id);
  const u = d.user;

  const field = (label, input) => h("div", { class: "field" }, h("label", {}, label), input);
  const fName = h("input", { class: "input", value: u.name || "" });
  const fEmail = h("input", { class: "input", value: u.email || "" });
  const fGender = h("select", { class: "input" },
    ["", "male", "female", "other"].map((g) =>
      h("option", { value: g, selected: (u.gender || "") === g }, g || "—")));
  const fBirthday = h("input", { class: "input", type: "date", value: u.birthday || "" });
  const fProf = h("input", { class: "input", value: u.profession || "" });
  const fOrg = h("input", { class: "input", value: u.organisation || "" });
  const fLoc = h("input", { class: "input", value: u.location || "" });
  const fLang = h("input", { class: "input", value: u.preferred_language || "" });

  const saveBtn = h("button", {
    class: "btn primary", onclick: async () => {
      try {
        await api("/users/" + id, { method: "PATCH", body: {
          name: fName.value.trim(), email: fEmail.value.trim(),
          gender: fGender.value, birthday: fBirthday.value,
          profession: fProf.value.trim(), organisation: fOrg.value.trim(),
          location: fLoc.value.trim(), preferred_language: fLang.value.trim(),
        }});
        toast("Profile saved.");
      } catch (e) { toast(e.message, true); }
    },
  }, "Save changes");

  const phoneInput = h("input", { class: "input", placeholder: u.phone_number ? "Change number…" : "Attach number…" });
  const phoneBtn = h("button", {
    class: "btn", onclick: async () => {
      try {
        const r = await api("/users/" + id + "/phone", { method: "POST", body: { phone: phoneInput.value } });
        toast("Phone set to " + r.phone + " (verified)."); render();
      } catch (e) { toast(e.message, true); }
    },
  }, "Set & verify");

  const pauseBtn = h("button", {
    class: "btn", onclick: async () => {
      try {
        await api("/users/" + id, { method: "PATCH", body: { status: u.status === "paused" ? "active" : "paused" } });
        toast(u.status === "paused" ? "Account resumed." : "Account paused."); render();
      } catch (e) { toast(e.message, true); }
    },
  }, u.status === "paused" ? "Resume account" : "Pause account");

  const pushBtn = h("button", {
    class: "btn", disabled: !u.has_device, onclick: async () => {
      const title = prompt("Notification title:", "Hello from MyAssistant");
      if (title === null) return;
      const body = prompt("Notification message:", "This is a test notification.");
      if (body === null) return;
      try { await api("/users/" + id + "/push", { method: "POST", body: { title, body } }); toast("Push sent."); }
      catch (e) { toast(e.message, true); }
    },
  }, "Send push");

  const clearBtn = h("button", {
    class: "btn", disabled: !u.has_device, onclick: async () => {
      if (!confirm("Clear this user's registered device? They re-register on next app launch.")) return;
      try { await api("/users/" + id + "/clear-device", { method: "POST" }); toast("Device cleared."); render(); }
      catch (e) { toast(e.message, true); }
    },
  }, "Clear device");

  const deleteBtn = h("button", {
    class: "btn danger", onclick: async () => {
      const typed = prompt(
        `This permanently deletes user #${id} (${u.email || u.name || "no email"}) and ALL their data — call recordings, documents, memories, reminders, everything. Type DELETE to confirm.`);
      if (typed !== "DELETE") return;
      try {
        // Show what actually went. Owner, 2026-09-25: "i ran but db files
        // have not yet deleted" — a bare "User deleted." proved nothing.
        const r = await api("/users/" + id, { method: "DELETE" });
        alert(erasedSummary(id, r));
        location.hash = "#/users";
      } catch (e) { toast(e.message, true); }
    },
  }, "Delete user");

  const c = d.counts;
  const asst = d.assistant;

  shell("#/users", h("div", {},
    h("a", { class: "backlink", href: "#/users" }, "← All users"),
    h("div", { class: "page-head" },
      h("div", { style: "display:flex; align-items:center; gap:14px;" },
        h("span", { class: "avatar", style: "width:46px; height:46px; font-size:16px;" }, initialsOf(u)),
        h("div", {},
          h("div", { class: "page-title" }, u.name || "No name"),
          h("div", { class: "page-sub" }, "#" + u.id + " · joined " + fmtDate(u.created_at) + " · " + (u.provider || "?")),
          h("div", { style: "margin-top:6px; display:flex; gap:6px; flex-wrap:wrap;" },
            statusBadge(u),
            u.phone_verified_at ? h("span", { class: "badge good" }, "phone verified")
                                : h("span", { class: "badge warn" }, "phone unverified"),
            d.googleLinked ? h("span", { class: "badge accent" }, "Google linked") : null,
            u.has_device ? h("span", { class: "badge accent" }, "push device") : h("span", { class: "badge neutral" }, "no device")))),
      h("div", { style: "display:flex; gap:8px; flex-wrap:wrap;" }, pauseBtn, pushBtn, clearBtn, deleteBtn)),

    h("div", { class: "detail-grid" },
      h("div", {},
        h("div", { class: "card" },
          h("h3", {}, "Profile ", h("span", { class: "hint" }, "editable — changes apply immediately")),
          h("div", { class: "grid two-col" },
            field("Name", fName), field("Email", fEmail),
            field("Gender", fGender), field("Birthday", fBirthday),
            field("Profession", fProf), field("Organisation", fOrg),
            field("Location", fLoc), field("Preferred language", fLang)),
          saveBtn,
          u.device_model || u.device_os
            ? h("div", { class: "sub", style: "margin-top:12px;" },
                "Handset: ", h("b", {}, u.device_model || "unknown"),
                u.device_os ? " · " + u.device_os : "",
                u.app_build ? " · build " + u.app_build : "")
            : null),
        h("div", { class: "card section-gap" },
          h("h3", {}, "Phone ", h("span", { class: "hint" }, "setting a number here also marks it verified")),
          u.phone_number ? h("div", { style: "margin-bottom:10px;" }, "Current: ", h("strong", {}, u.phone_number)) : null,
          h("div", { class: "inline-form" }, phoneInput, phoneBtn)),
        h("div", { class: "section-gap" }, spendCard(id)),
        h("div", { class: "section-gap" }, selfCheckCard(id)),
        h("div", { class: "section-gap" }, conversationCard(d.conversations, id)),
        h("div", { class: "section-gap" }, ledgerCard(id)),
        h("div", { class: "section-gap" }, documentsCard(id, c.docs)),
        h("div", { class: "card section-gap" },
          h("h3", {}, "Recent activity"),
          d.recent.length ? d.recent.map((x) => h("div", { class: "feed-item" },
            h("div", { class: "feed-dot" }),
            h("div", {}, h("div", {}, x.action),
              h("div", { class: "when" }, (x.detail ? x.detail + " — " : "") + timeAgo(x.created_at)))))
            : h("div", { class: "chart-empty" }, "No recorded activity."))),
      h("div", {},
        h("div", { class: "card" },
          h("h3", {}, "App"),
          h("div", { class: "stat-mini" }, h("span", { class: "k" }, "Version"),
            h("span", { class: "v" }, u.app_build ? "build " + u.app_build : "unknown")),
          h("div", { class: "stat-mini" }, h("span", { class: "k" }, "Reported"),
            h("span", { class: "v" }, u.app_build_at ? timeAgo(u.app_build_at) : "—")),
          h("div", { class: "stat-mini" }, h("span", { class: "k" }, "Last seen"),
            h("span", { class: "v" }, u.last_seen_at ? timeAgo(u.last_seen_at) : "—"))),
        h("div", { class: "card section-gap" },
          h("h3", {}, "Assistant"),
          asst ? [
            h("div", { class: "stat-mini" }, h("span", { class: "k" }, "Name"), h("span", { class: "v" }, asst.name || "Assistant")),
            h("div", { class: "stat-mini" }, h("span", { class: "k" }, "Voice"), h("span", { class: "v" }, asst.voice || "default")),
            h("div", { class: "stat-mini" }, h("span", { class: "k" }, "Style"), h("span", { class: "v" }, asst.style || "default")),
            h("div", { class: "stat-mini" }, h("span", { class: "k" }, "Face"), h("span", { class: "v" }, asst.avatar_id ? asst.avatar_id.slice(0, 8) + "…" : "default")),
          ] : h("div", { class: "faint" }, "Not configured yet.")),
        h("div", { class: "card section-gap" },
          h("h3", {}, "Data footprint"),
          h("div", { class: "stat-mini" }, h("span", { class: "k" }, "Actions (all time)"), h("span", { class: "v" }, c.actionsTotal)),
          h("div", { class: "stat-mini" }, h("span", { class: "k" }, "Reminders (open/all)"), h("span", { class: "v" }, c.remindersOpen + " / " + c.remindersAll)),
          h("div", { class: "stat-mini" }, h("span", { class: "k" }, "Open promises"), h("span", { class: "v" }, c.commitsOpen)),
          h("div", { class: "stat-mini" }, h("span", { class: "k" }, "Documents"), h("span", { class: "v" }, c.docs)),
          h("div", { class: "stat-mini" }, h("span", { class: "k" }, "Memories"), h("span", { class: "v" }, c.memories)),
          h("div", { class: "stat-mini" }, h("span", { class: "k" }, "Client files"), h("span", { class: "v" }, c.clients)),
          h("div", { class: "stat-mini" }, h("span", { class: "k" }, "Finance items"), h("span", { class: "v" }, c.finance)),
          h("div", { class: "stat-mini" }, h("span", { class: "k" }, "Contacts synced"), h("span", { class: "v" }, c.contacts)),
          h("div", { class: "stat-mini" }, h("span", { class: "k" }, "Agent messages"), h("span", { class: "v" }, c.msgs))),
        h("div", { class: "card section-gap" },
          h("h3", {}, "Standing rules"),
          d.instructions.length
            ? d.instructions.map((i) => h("div", { class: "feed-item" }, h("div", { class: "feed-dot" }), h("div", {}, i.instruction)))
            : h("div", { class: "faint" }, "None set.")))
    )));
}

/* ------------------------------------------------------------------ */
/* Analytics                                                           */
/* ------------------------------------------------------------------ */

async function viewAnalytics() {
  shell("#/analytics", loading());
  const d = await api("/analytics");
  shell("#/analytics", h("div", {},
    pageHead("Analytics", "Growth, engagement, and what the assistant is being used for."),
    h("div", { class: "grid two-col" },
      h("div", { class: "card" }, h("h3", {}, "Signups — last 30 days"), barChart(d.signups30)),
      h("div", { class: "card" }, h("h3", {}, "Active users per day — last 14 days"), barChart(d.dau14)),
      h("div", { class: "card" }, h("h3", {}, "Actions per day — last 14 days"), barChart(d.actions14)),
      h("div", { class: "card" }, h("h3", {}, "Messages relayed per day — last 14 days"), barChart(d.msgs14))),
    h("div", { class: "grid two-col section-gap" },
      h("div", { class: "card" },
        h("h3", {}, "App versions in use ", h("span", { class: "hint" }, "is the update reaching everyone?")),
        hbarList((d.versions || []).map((v) => ({
          label: v.build ? "build " + v.build : "unknown", count: v.users })))),
      h("div", { class: "card" },
        h("h3", {}, "Days active per user — last 7 days ", h("span", { class: "hint" }, "stickiness")),
        hbarList((d.engagement || []).map((e) => ({
          label: e.days_active + (e.days_active === 1 ? " day" : " days"), count: e.users })))),
      h("div", { class: "card" },
        h("h3", {}, "Reply time — last 7 days"),
        (() => {
          const l = (d.convStats && d.convStats.latency) || {};
          const ms = (v) => (v ? (v / 1000).toFixed(1) + "s" : "—");
          return h("div", {},
            h("div", { class: "stat-mini" }, h("span", { class: "k" }, "Turns"), h("span", { class: "v" }, String(l.turns || 0))),
            h("div", { class: "stat-mini" }, h("span", { class: "k" }, "Median"), h("span", { class: "v" }, ms(l.p50))),
            h("div", { class: "stat-mini" }, h("span", { class: "k" }, "90th percentile"), h("span", { class: "v" }, ms(l.p90))),
            h("div", { class: "stat-mini" }, h("span", { class: "k" }, "Slowest"), h("span", { class: "v" }, ms(l.max_ms))));
        })()),
      h("div", { class: "card" },
        h("h3", {}, "Tools used — last 7 days"),
        hbarList(((d.convStats && d.convStats.byTool) || []).map((t) => ({ label: t.tool, count: t.n })))),
      h("div", { class: "card" },
        h("h3", {}, "Top actions — last 30 days ", h("span", { class: "hint" }, "what people actually use")),
        hbarList(d.topActions.map((a) => ({ label: a.action, count: a.count })))),
      h("div", { class: "card table-card" },
        h("h3", { style: "padding:10px 12px 0;" }, "Most active users — last 30 days"),
        h("table", {},
          h("thead", {}, h("tr", {}, h("th", {}, "User"), h("th", {}, "Actions"))),
          h("tbody", {},
            d.topUsers.length ? d.topUsers.map((t) =>
              h("tr", { class: "rowlink", onclick: () => { location.hash = "#/user/" + t.user_id; } },
                h("td", {}, t.name), h("td", { class: "num" }, t.count)))
              : h("tr", {}, h("td", { colspan: 2, class: "chart-empty" }, "No data yet."))))))
  ));
}

/* ------------------------------------------------------------------ */
/* Action ledger — the middle of a turn, which nothing else showed     */
/* ------------------------------------------------------------------ */

/** requested_action -> tool -> arguments -> result -> final_response. */
function ledgerCard(userId) {
  const body = h("div", { class: "chart-empty" }, "Loading the action ledger…");
  const card = h("div", { class: "card" },
    h("div", { style: "display:flex; align-items:center; gap:10px; margin-bottom:12px;" },
      h("h3", { style: "margin:0;" }, "Action ledger ",
        h("span", { class: "hint" }, "what was asked, what ran, what came back")),
      h("div", { style: "flex:1;" }),
      h("button", {
        class: "btn sm",
        onclick: () => window.open(`/admin-panel/api/users/${userId}/ledger.csv`, "_blank"),
      }, "Download CSV")),
    body);

  api(`/users/${userId}/ledger?limit=40`)
    .then((d) => {
      if (!d.turns.length) {
        body.replaceWith(h("div", { class: "chart-empty" }, "No actions recorded yet."));
        return;
      }
      body.replaceWith(h("div", {}, d.turns.map((t) =>
        h("div", { class: "ledger-turn" },
          h("div", { class: "ledger-head" },
            h("span", { class: "ledger-when" }, timeAgo(t.at)),
            t.surface ? h("span", { class: "badge neutral" }, t.surface) : null,
            h("span", { class: "ledger-intent" },
              t.intent || h("span", { class: "faint" }, "(no request recorded)"))),
          h("div", { class: "ledger-steps" }, t.steps.map((st) =>
            h("div", { class: "ledger-step" },
              h("span", {
                class: "badge " + (st.decision && st.decision !== "ran"
                  ? (DECISION_CLASS[st.decision] || "neutral")
                  : st.ok ? "good" : "danger"),
              }, st.decision && st.decision !== "ran"
                ? st.decision
                : st.ok ? "ran" : "failed"),
              h("code", { class: "ledger-tool" }, st.tool),
              st.args && st.args !== "{}"
                ? h("code", { class: "ledger-args" }, st.args)
                : null,
              h("span", { class: "ledger-result" }, st.result || st.detail || ""),
              st.ms ? h("span", { class: "ledger-when" }, st.ms + "ms") : null))),
          t.reply
            ? h("div", { class: "ledger-reply" }, "↳ ", t.reply)
            : h("div", { class: "ledger-reply faint" }, "↳ no reply recorded")))));
    })
    .catch((e) => {
      if (e.message !== "signed out") {
        body.replaceWith(h("div", { class: "chart-empty" }, "Could not load the ledger: " + e.message));
      }
    });

  return card;
}

/* ------------------------------------------------------------------ */
/* Saved documents                                                     */
/*                                                                     */
/* A count told you nothing about whether filing actually works. These */
/* tiles show the document as the user has it: the picture or PDF, the */
/* title analysis produced (or a warning that it never landed), which  */
/* case file it went into, and whether the bytes are still on disk.    */
/* ------------------------------------------------------------------ */

const DOC_CATEGORIES = ["medical", "prescription", "receipt", "bill", "id", "ticket", "other"];

const fmtBytes = (n) => {
  const b = Number(n) || 0;
  if (b < 1024) return b + " B";
  if (b < 1024 * 1024) return Math.round(b / 1024) + " KB";
  return (b / 1048576).toFixed(1) + " MB";
};

/** PDF / JPG / PNG — the short kind shown when there is no thumbnail. */
const docKind = (mime) => {
  const m = String(mime || "");
  if (m === "application/pdf") return "PDF";
  if (m.startsWith("image/")) return m.slice(6).toUpperCase();
  if (m.startsWith("text/")) return "TEXT";
  return "FILE";
};

const PREVIEWS_INLINE = new Set(["image/jpeg", "image/png", "image/webp", "image/gif",
  "application/pdf", "text/plain", "video/mp4"]);
const docFileUrl = (d, download) =>
  `/admin-panel/api/documents/${d.id}/file` + (download ? "?download=1" : "");

/** One document as a tile. Clicking opens the real file in a new tab. */
function docTile(d, { showUser = false } = {}) {
  const isImage = String(d.mime || "").startsWith("image/") && d.onDisk;
  const thumb = h("div", { class: "doc-thumb" },
    isImage
      ? h("img", { src: docFileUrl(d), alt: "", loading: "lazy" })
      : h("span", { class: "doc-kind" }, d.onDisk ? docKind(d.mime) : "MISSING"));

  return h("div", {
    class: "doc-tile",
    title: d.summary || d.note || d.title,
    onclick: () => {
      if (!d.onDisk) return toast("That file is no longer on disk.", true);
      // Word files and the like cannot show in a browser tab: they open
      // as a page of their own (converted, or their extracted text).
      window.open(PREVIEWS_INLINE.has(String(d.mime || "").toLowerCase())
        ? docFileUrl(d) : `/admin-panel/api/documents/${d.id}/view`, "_blank");
    },
  },
    thumb,
    h("div", { class: "doc-body" },
      h("div", { class: "doc-title" }, d.title),
      h("div", { class: "doc-chips" },
        h("span", { class: "badge neutral" }, d.category),
        d.clientId
          ? h("span", { class: "badge accent" }, d.clientName || "case file")
          : null,
        !d.analyzed ? h("span", { class: "badge warn" }, "not analysed") : null,
        !d.onDisk ? h("span", { class: "badge danger" }, "file missing") : null),
      h("div", { class: "doc-meta" },
        showUser && d.userId
          ? h("a", {
              href: "#/user/" + d.userId,
              onclick: (e) => e.stopPropagation(),
            }, d.userName || "#" + d.userId)
          : null,
        h("span", {}, fmtBytes(d.size)),
        h("span", {}, "·"),
        h("span", {}, d.docDate || fmtDate(d.createdAt)))));
}

/**
 * The documents card on a user's detail page. Loaded on its own after
 * the page renders — a user with hundreds of saves must not hold up
 * everything else on the page.
 */
function documentsCard(userId, count) {
  const body = h("div", { class: "chart-empty" }, "Loading documents…");
  const card = h("div", { class: "card" },
    h("div", { style: "display:flex; align-items:center; gap:10px; margin-bottom:12px;" },
      h("h3", { style: "margin:0;" }, "Saved documents"),
      h("div", { style: "flex:1;" }),
      count
        ? h("button", {
            class: "btn sm",
            onclick: () => window.open(
              `/admin-panel/api/documents.csv?user_id=${userId}&limit=2000`, "_blank"),
          }, "Download CSV")
        : null),
    body);

  api(`/users/${userId}/documents?limit=200`)
    .then((d) => {
      if (!d.documents.length) {
        body.replaceWith(h("div", { class: "chart-empty" }, "Nothing saved yet."));
        return;
      }
      const missing = d.documents.filter((x) => !x.onDisk).length;
      const unanalysed = d.documents.filter((x) => !x.analyzed).length;
      body.replaceWith(h("div", {},
        h("div", { class: "doc-meta", style: "margin-bottom:10px;" },
          h("span", {}, d.total + (d.total === 1 ? " document" : " documents")
            + (d.shown < d.total ? ` (showing ${d.shown})` : "")),
          h("span", {}, "·"),
          h("span", {}, fmtBytes(d.totalBytes)),
          ...d.byCategory.map((c) =>
            h("span", { class: "badge neutral" }, `${c.category} ${c.n}`)),
          unanalysed ? h("span", { class: "badge warn" }, unanalysed + " not analysed") : null,
          missing ? h("span", { class: "badge danger" }, missing + " missing on disk") : null),
        h("div", { class: "doc-grid" }, d.documents.map((x) => docTile(x)))));
    })
    .catch((e) => {
      if (e.message !== "signed out") {
        body.replaceWith(h("div", { class: "chart-empty" }, "Could not load documents: " + e.message));
      }
    });

  return card;
}

/** Every saved document, across every user. */
async function viewDocuments() {
  shell("#/documents", loading());
  let q = "", category = "", area = "", offset = 0;

  const search = h("input", { class: "input", placeholder: "Search title, note, tags or user…", style: "max-width:300px;" });
  const catSel = h("select", { class: "input" },
    h("option", { value: "" }, "All categories"),
    DOC_CATEGORIES.map((c) => h("option", { value: c }, c)));
  const areaSel = h("select", { class: "input" },
    h("option", { value: "" }, "Everywhere"),
    h("option", { value: "personal" }, "Personal only"),
    h("option", { value: "clients" }, "Case files only"));

  const grid = h("div", { class: "doc-grid" });
  const summary = h("div", { class: "doc-meta", style: "margin-bottom:14px;" });
  const moreBtn = h("button", { class: "btn", onclick: () => load(true) }, "Load more");

  const qs = () =>
    `q=${encodeURIComponent(q)}&category=${encodeURIComponent(category)}` +
    `&area=${encodeURIComponent(area)}`;

  async function load(append) {
    if (!append) { offset = 0; grid.replaceChildren(); }
    const d = await api(`/documents?${qs()}&limit=60&offset=${offset}`);
    offset += d.documents.length;
    if (d.documents.length) {
      grid.append(...d.documents.map((x) => docTile(x, { showUser: true })));
    } else if (!append) {
      grid.append(h("div", { class: "chart-empty" }, "No documents match that."));
    }
    summary.replaceChildren(
      h("span", {}, `${offset} of ${d.total} shown`),
      ...d.categories.map((c) => h("span", { class: "badge neutral" }, `${c.category} ${c.n}`)));
    moreBtn.disabled = offset >= d.total;
  }

  let debounce = null;
  search.addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => { q = search.value.trim(); load(false); }, 300);
  });
  catSel.addEventListener("change", () => { category = catSel.value; load(false); });
  areaSel.addEventListener("change", () => { area = areaSel.value; load(false); });

  shell("#/documents", h("div", {},
    pageHead("Documents", "Everything users have saved — the file itself, how it was filed, and whether analysis landed.",
      h("button", {
        class: "btn",
        onclick: () => window.open(`/admin-panel/api/documents.csv?${qs()}&limit=2000`, "_blank"),
      }, "Download CSV")),
    h("div", { class: "doc-filters" }, search, catSel, areaSel),
    summary,
    grid,
    h("div", { style: "margin-top:16px; text-align:center;" }, moreBtn)));

  await load(false);
}

/* ------------------------------------------------------------------ */
/* Conversations — questions, answers, response times                   */
/* ------------------------------------------------------------------ */

/** Response-time pill: green under 2s, amber under 5s, red beyond. */
function latencyPill(ms) {
  if (!ms) return h("span", { class: "faint" }, "—");
  const s = (ms / 1000).toFixed(1) + "s";
  const cls = ms < 2000 ? "good" : ms < 5000 ? "warn" : "danger";
  return h("span", { class: "badge " + cls }, s);
}

async function viewConversations() {
  shell("#/conversations", loading());
  let q = "", source = "", minMs = 0, offset = 0;
  const body = h("tbody", {});
  const statsRow = h("div", { style: "display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px;margin-bottom:16px;" });
  const moreBtn = h("button", { class: "btn", style: "margin:12px;" }, "Load more");

  const stat = (label, value, tone) =>
    h("div", { class: "card", style: "padding:14px 16px;" },
      h("div", { class: "sub", style: "font-size:12px;" }, label),
      h("div", { style: `font-size:24px;font-weight:700;${tone ? "color:" + tone + ";" : ""}` }, String(value)));

  async function load(append) {
    const d = await api(
      `/conversations?q=${encodeURIComponent(q)}&source=${source}&min_ms=${minMs}` +
      `&offset=${offset}&limit=50&days=7`);
    if (!append) {
      const l = (d.stats && d.stats.latency) || {};
      const ms = (v) => (v ? (v / 1000).toFixed(1) + "s" : "—");
      statsRow.replaceChildren(
        stat("Turns (7d)", l.turns || 0),
        stat("Median reply", ms(l.p50)),
        stat("90th percentile", ms(l.p90), l.p90 > 5000 ? "#b45309" : ""),
        stat("Slowest", ms(l.max_ms), l.max_ms > 10000 ? "#b91c1c" : ""),
        stat("Average", ms(l.avg_ms)));
    }
    const rows = d.conversations.map((c) =>
      h("tr", {},
        h("td", { class: "sub", style: "white-space:nowrap;" }, timeAgo(c.created_at)),
        h("td", {}, c.user_id
          ? h("a", { href: "#/user/" + c.user_id }, c.user_name || "#" + c.user_id)
          : h("span", { class: "faint" }, "—")),
        h("td", { style: "max-width:280px;" }, c.question || h("span", { class: "faint" }, "—")),
        h("td", { class: "sub", style: "max-width:380px;" }, c.answer || "",
          c.audio_id ? h("div", { style: "margin-top:6px;" },
            h("audio", { controls: "controls", preload: "none", style: "width:240px;height:30px;",
                         src: `/admin-panel/api/recordings/${c.audio_id}/audio` })) : null),
        h("td", {}, latencyPill(c.latency_ms)),
        h("td", { class: "sub" }, c.tools || ""),
        h("td", { class: "sub", style: "white-space:nowrap;" },
          (c.source || "?") + (c.app_build ? " · b" + c.app_build : ""))));
    if (!append) body.replaceChildren();
    if (rows.length) body.append(...rows);
    else if (!append) body.append(h("tr", {}, h("td", { colspan: 7, class: "chart-empty" }, "No conversations recorded yet.")));
    moreBtn.disabled = d.conversations.length < 50;
  }
  moreBtn.addEventListener("click", () => { offset += 50; load(true).catch((e) => toast(e.message, true)); });

  const reload = () => { offset = 0; load(false).catch((x) => toast(x.message, true)); };
  const search = h("input", {
    class: "input", style: "max-width:260px;", placeholder: "Search questions and answers…",
    oninput: debounce((e) => { q = e.target.value.trim(); reload(); }, 300),
  });
  const sel = (opts, onchange) =>
    h("select", { class: "input", style: "max-width:160px;", onchange: (e) => onchange(e.target.value) },
      ...opts.map(([v, l]) => h("option", { value: v }, l)));
  const sourceSel = sel([["", "All surfaces"], ["ai-cloud", "App: cloud"], ["ai-nano", "App: on-device"],
    ["ai-search", "App: search"], ["ai-shortcut", "App: shortcut"], ["live", "Live voice (old)"], ["voice", "Voice / chat (old)"],
    ["background", "Scheduled"]], (v) => { source = v; reload(); });
  const slowSel = sel([["0", "Any speed"], ["3000", "Slower than 3s"], ["6000", "Slower than 6s"],
    ["10000", "Slower than 10s"]], (v) => { minMs = parseInt(v, 10) || 0; reload(); });

  // Downloads exactly what the filters are showing, as a spreadsheet.
  const csvBtn = h("button", {
    class: "btn",
    onclick: () => {
      const qs = `q=${encodeURIComponent(q)}&source=${source}&min_ms=${minMs}&limit=2000`;
      window.open(`/admin-panel/api/conversations.csv?${qs}`, "_blank");
    },
  }, "Download CSV");

  shell("#/conversations", h("div", {},
    h("div", { class: "page-head" },
      h("div", {}, h("div", { class: "page-title" }, "Conversations"),
        h("div", { class: "page-sub" }, "Every question asked, the assistant's answer, how long it took and which tools ran.")),
      h("div", { style: "display:flex; gap:8px; flex-wrap:wrap;" },
        search, sourceSel, slowSel, csvBtn)),
    statsRow,
    h("div", { class: "card table-card" },
      h("table", {},
        h("thead", {}, h("tr", {},
          h("th", {}, "When"), h("th", {}, "User"), h("th", {}, "Question"),
          h("th", {}, "Answer"), h("th", {}, "Reply time"), h("th", {}, "Tools"),
          h("th", {}, "Surface"))),
        body),
      moreBtn)));
  await load(false);
}

/* ------------------------------------------------------------------ */
/* Phones — which handset, and how the assistant does on it            */
/* ------------------------------------------------------------------ */

async function viewPhones() {
  shell("#/phones", loading());
  const d = await api("/devices?days=7");
  const ms = (v) => (v ? (v / 1000).toFixed(1) + "s" : "—");
  const rows = d.devices.map((r) =>
    h("tr", {},
      h("td", {}, h("a", { href: "#/user/" + r.user_id }, r.name || "#" + r.user_id)),
      h("td", {}, r.model || h("span", { class: "faint" }, "not reported yet"),
        r.os_version ? h("div", { class: "sub" }, r.os_version) : null),
      h("td", {}, r.app_build ? h("span", { class: "badge neutral" }, "build " + r.app_build)
                              : h("span", { class: "faint" }, "—")),
      h("td", { class: "sub" }, String(r.turns || 0),
        r.live_turns ? h("span", { class: "faint" }, ` (${r.live_turns} fast voice)`) : null),
      h("td", {}, latencyPill(r.p50 || 0)),
      h("td", {}, r.max_ms ? latencyPill(r.max_ms) : h("span", { class: "faint" }, "—")),
      h("td", { class: r.slow_turns ? "" : "faint" }, String(r.slow_turns || 0)),
      h("td", { class: "sub", style: "max-width:260px;" },
        r.denied ? h("span", { style: "color:#b45309;" }, "denied: " + r.denied) : h("span", { class: "faint" }, "all granted")),
      h("td", { class: "sub", style: "white-space:nowrap;" },
        timeAgo(Math.max(Number(r.seen_at || 0), Number(r.last_seen_at || 0)) || Date.now()))));
  shell("#/phones", h("div", {},
    h("div", { class: "page-head" },
      h("div", {}, h("div", { class: "page-title" }, "Phones"),
        h("div", { class: "page-sub" },
          "Each tester's handset and Android version beside the assistant's reply times for them this week. " +
          "A phone with a slow median or many slow turns is where to look when it \"acts differently\"."))),
    h("div", { class: "card table-card" },
      h("table", {},
        h("thead", {}, h("tr", {},
          h("th", {}, "User"), h("th", {}, "Phone"), h("th", {}, "App"),
          h("th", {}, "Turns (7d)"), h("th", {}, "Median reply"), h("th", {}, "Slowest"),
          h("th", {}, "Slow (>6s)"), h("th", {}, "Permissions"), h("th", {}, "Last seen"))),
        h("tbody", {}, ...(rows.length ? rows
          : [h("tr", {}, h("td", { colspan: 9, class: "chart-empty" }, "No phones reported yet."))]))))));
}

/* ------------------------------------------------------------------ */
/* Activity explorer                                                   */
/* ------------------------------------------------------------------ */

async function viewActivity() {
  shell("#/activity", loading());
  let q = "", offset = 0;
  const body = h("tbody", {});
  const moreBtn = h("button", { class: "btn", style: "margin:12px;" }, "Load more");

  async function load(append) {
    const d = await api(`/activity?q=${encodeURIComponent(q)}&offset=${offset}&limit=50`);
    const rows = d.activity.map((x) =>
      h("tr", {},
        h("td", { class: "sub", style: "white-space:nowrap;" }, timeAgo(x.created_at)),
        h("td", {}, x.user_id
          ? h("a", { href: "#/user/" + x.user_id }, x.name || "#" + x.user_id)
          : h("span", { class: "faint" }, "—")),
        h("td", {}, x.action),
        h("td", { class: "sub" }, x.detail || "")));
    if (!append) body.replaceChildren();
    if (rows.length) body.append(...rows);
    else if (!append) body.append(h("tr", {}, h("td", { colspan: 4, class: "chart-empty" }, "Nothing matches.")));
    moreBtn.disabled = d.activity.length < 50;
  }
  moreBtn.addEventListener("click", () => { offset += 50; load(true).catch((e) => toast(e.message, true)); });

  const search = h("input", {
    class: "input", style: "max-width:280px;", placeholder: "Filter by action or detail…",
    oninput: debounce((e) => { q = e.target.value.trim(); offset = 0; load(false).catch((x) => toast(x.message, true)); }, 300),
  });

  shell("#/activity", h("div", {},
    h("div", { class: "page-head" },
      h("div", {}, h("div", { class: "page-title" }, "Activity"),
        h("div", { class: "page-sub" }, "Every audited action across the platform.")), search),
    h("div", { class: "card table-card" },
      h("table", {},
        h("thead", {}, h("tr", {}, h("th", {}, "When"), h("th", {}, "User"), h("th", {}, "Action"), h("th", {}, "Detail"))),
        body),
      moreBtn)));
  await load(false);
}

/* ------------------------------------------------------------------ */
/* Live — every move of every user, as it happens (2026-10-08)          */
/* ------------------------------------------------------------------ */

const LIVE_FILTERS = [
  ["all", "Everything", "say,action,outcome,feedback"],
  ["say", "What was said", "say"],
  ["action", "Actions", "action"],
  ["outcome", "Results", "outcome"],
  ["failed", "Failures", "action,outcome"],
  ["feedback", "Feedback", "feedback"],
];

/** A tool's args/result as readable lines, or the raw text. */
function prettyJson(s) {
  if (s == null || s === "") return "";
  try { return JSON.stringify(typeof s === "string" ? JSON.parse(s) : s, null, 2); } catch (_) { return String(s); }
}

function liveRow(x) {
  const when = new Date(x.created_at);
  const time = when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const day = when.toLocaleDateString([], { day: "numeric", month: "short" });
  const who = x.user_id
    ? h("a", { href: "#/user/" + x.user_id, onclick: (e) => e.stopPropagation() }, x.user_name || "#" + x.user_id)
    : h("span", { class: "faint" }, "—");
  const hidden = h("span", { class: "faint" }, "(hidden: Help improve is off)");
  let icon = "•", badge = null, main = null;
  const details = [];

  if (x.type === "say") {
    const user = x.role === "user";
    icon = user ? "🗣" : "🤖";
    badge = h("span", { class: "badge " + (user ? "accent" : "neutral") }, user ? "User said" : "Assistant");
    main = x.readable ? h("span", {}, x.text || "") : hidden;
    details.push(["Source", `${x.source || ""} · build ${x.app_build || "?"}${x.latency_ms ? ` · ${x.latency_ms} ms` : ""}`]);
    if (x.tools) details.push(["Tools", String(x.tools)]);
  } else if (x.type === "action") {
    const bad = Number(x.ok) === 0 || x.decision === "refused" || x.decision === "suppressed";
    icon = bad ? "⚠️" : Number(x.world) ? "⚡" : "🔎";
    badge = h("span", { class: "badge " + (bad ? "danger" : Number(x.world) ? "good" : "neutral") },
      `${x.tool}${x.decision && x.decision !== "ran" ? ` · ${x.decision}` : bad ? " · failed" : ""}`);
    main = x.readable
      ? h("span", {}, x.target ? `→ ${x.target}` : "", x.reply ? h("span", { class: "sub" }, `  “${String(x.reply).slice(0, 160)}”`) : "")
      : hidden;
    if (x.readable) {
      if (x.intent) details.push(["User asked", x.intent]);
      if (x.args) details.push(["Given", prettyJson(x.args)]);
      if (x.result) details.push(["Came back", prettyJson(x.result)]);
      if (x.detail) details.push(["Detail", x.detail]);
      if (x.reply) details.push(["Assistant said", x.reply]);
    }
    details.push(["Run", `${x.surface || ""}${x.ms != null ? ` · ${x.ms} ms` : ""} · ${Number(x.world) ? "acts on the world" : "read-only"}`]);
  } else if (x.type === "outcome") {
    const bad = ["failed", "no_answer", "cancelled", "unconfirmed"].includes(x.status);
    icon = bad ? "❌" : "✅";
    badge = h("span", { class: "badge " + (bad ? "danger" : x.status === "completed" || x.status === "connected" ? "good" : "warn") },
      `${x.kind} · ${x.status}`);
    main = x.readable ? h("span", {}, `${x.target || ""}${x.detail ? ` — ${x.detail}` : ""}`) : hidden;
    if (x.readable && x.reason) details.push(["Why", x.reason]);
    details.push(["Path", x.path || ""]);
  } else if (x.type === "feedback") {
    icon = "💬";
    badge = h("span", { class: "badge warn" }, `feedback · ${x.kind || ""}`);
    main = h("span", {}, x.summary || "");
    if (x.user_words) details.push(["In their words", x.user_words]);
    if (x.details) details.push(["Details", x.details]);
  }

  const more = h("div", { class: "live-more", style: "display:none;" },
    ...details.map(([k, v]) => h("div", { class: "live-kv" },
      h("div", { class: "faint" }, k),
      h("pre", {}, String(v)))));
  return h("div", {
    class: "live-row live-" + x.type,
    onclick: () => { more.style.display = more.style.display === "none" ? "block" : "none"; },
  },
    h("div", { class: "live-line" },
      h("span", { class: "live-time", title: when.toLocaleString() }, `${day} ${time}`),
      h("span", { class: "live-icon" }, icon),
      h("span", { class: "live-user" }, who),
      badge,
      h("span", { class: "live-main" }, main)),
    more);
}

async function viewLive() {
  shell("#/live", loading());
  let filter = "all", userId = "", q = "", newest = 0, oldest = 0, paused = false, timer = null;
  const list = h("div", { class: "live-list" });
  const status = h("span", { class: "sub" }, "");
  const userSel = h("select", { class: "input", style: "max-width:220px;",
    onchange: (e) => { userId = e.target.value; reload(); } }, h("option", { value: "" }, "All users"));
  const chips = h("div", { style: "display:flex; gap:6px; flex-wrap:wrap;" });
  const pauseBtn = h("button", { class: "btn", onclick: () => {
    paused = !paused; pauseBtn.textContent = paused ? "Resume live" : "Pause";
  } }, "Pause");
  const more = h("button", { class: "btn", style: "margin:12px auto; display:block;", onclick: () => older() }, "Older");

  function url(extra) {
    const f = LIVE_FILTERS.find((x) => x[0] === filter);
    return `/live?type=${f[2]}${filter === "failed" ? "&failed=1" : ""}` +
      `${userId ? `&user_id=${userId}` : ""}${q ? `&q=${encodeURIComponent(q)}` : ""}${extra}`;
  }
  function drawChips() {
    chips.replaceChildren(...LIVE_FILTERS.map(([k, label]) =>
      h("button", { class: "btn" + (k === filter ? " primary" : ""), onclick: () => { filter = k; drawChips(); reload(); } }, label)));
  }
  async function reload() {
    newest = 0; oldest = 0;
    list.replaceChildren(loading());
    const d = await api(url(""));
    if (userSel.options.length <= 1) {
      for (const u of d.users || []) userSel.append(h("option", { value: u.id }, `${u.name || "User"} #${u.id} · ${timeAgo(u.last)}`));
    }
    list.replaceChildren(...(d.items.length ? d.items.map(liveRow) : [h("div", { class: "chart-empty" }, "Nothing in the last 14 days.")]));
    if (d.items.length) { newest = d.items[0].created_at; oldest = d.items[d.items.length - 1].created_at; }
    status.textContent = `Updated ${new Date().toLocaleTimeString()}`;
  }
  async function poll() {
    if (paused || !newest || document.hidden) return;
    try {
      const d = await api(url(`&since=${newest}`));
      if (d.items.length) {
        newest = d.items[0].created_at;
        const rows = d.items.map(liveRow);
        rows.forEach((r) => r.classList.add("live-new"));
        list.prepend(...rows);
      }
      status.textContent = `Live · updated ${new Date().toLocaleTimeString()}`;
    } catch (_) { status.textContent = "Live · reconnecting…"; }
  }
  async function older() {
    if (!oldest) return;
    const d = await api(url(`&before=${oldest}`));
    if (d.items.length) {
      oldest = d.items[d.items.length - 1].created_at;
      list.append(...d.items.map(liveRow));
    } else more.disabled = true;
  }

  const search = h("input", { class: "input", style: "max-width:240px;", placeholder: "Search words, tools, results…",
    oninput: debounce((e) => { q = e.target.value.trim(); reload().catch((x) => toast(x.message, true)); }, 350) });
  drawChips();
  shell("#/live", h("div", {},
    pageHead("Live", "Everything every user said and did, and what really happened — newest first, updating every 5 seconds. Click a row for the full detail.", pauseBtn),
    h("div", { class: "card", style: "padding:12px; display:flex; gap:10px; flex-wrap:wrap; align-items:center; margin-bottom:12px;" },
      chips, userSel, search, status),
    h("div", { class: "card" }, list, more)));
  await reload();
  timer = setInterval(() => {
    if (location.hash !== "#/live") return clearInterval(timer);
    poll();
  }, 5000);
}

/* ------------------------------------------------------------------ */
/* Feedback — what the assistant told the developer                    */
/* ------------------------------------------------------------------ */

const FEEDBACK_KIND = {
  // Filed by the server itself (feedback/store.alert), e.g. the calling
  // service rejecting our caller number.
  alert: ["Alert", "danger"],
  bug: ["Bug", "danger"],
  complaint: ["Complaint", "warn"],
  feature: ["Feature request", "accent"],
  improvement: ["Improvement", "neutral"],
  praise: ["Praise", "good"],
};

async function viewFeedback() {
  shell("#/feedback", loading());
  let status = "new", q = "", offset = 0;
  const body = h("tbody", {});
  const moreBtn = h("button", { class: "btn", style: "margin:12px;" }, "Load more");
  const tabs = h("div", { style: "display:flex; gap:8px;" });

  function drawTabs(counts) {
    const tab = (value, label) => h("button", {
      class: "btn sm" + (status === value ? " primary" : ""),
      onclick: () => { status = value; offset = 0; load(false).catch((e) => toast(e.message, true)); },
    }, label);
    tabs.replaceChildren(
      tab("new", `New (${counts.new})`),
      tab("seen", `Seen (${counts.seen})`),
      tab("done", `Done (${counts.done})`),
      tab("", "All"));
  }

  async function setStatus(id, next) {
    try {
      await api("/feedback/" + id, { method: "POST", body: { status: next } });
      toast(next === "done" ? "Marked done." : "Marked seen.");
      offset = 0;
      await load(false);
    } catch (e) { toast(e.message, true); }
  }

  async function load(append) {
    const d = await api(`/feedback?status=${status}&q=${encodeURIComponent(q)}&offset=${offset}&limit=50`);
    drawTabs(d.counts);
    const rows = d.feedback.map((f) => {
      const [kindLabel, tone] = FEEDBACK_KIND[f.kind] || [f.kind, "neutral"];
      const actions = h("div", { style: "display:flex; gap:6px; justify-content:flex-end;" },
        f.status === "new" ? h("button", { class: "btn sm", onclick: () => setStatus(f.id, "seen") }, "Seen") : null,
        f.status !== "done" ? h("button", { class: "btn sm primary", onclick: () => setStatus(f.id, "done") }, "Done") : null,
        f.status === "done" ? h("button", { class: "btn sm", onclick: () => setStatus(f.id, "new") }, "Reopen") : null);
      return h("tr", {},
        h("td", { class: "sub", style: "white-space:nowrap;" }, timeAgo(f.created_at)),
        h("td", {}, h("span", { class: "badge " + tone }, kindLabel)),
        h("td", {},
          h("div", { style: "font-weight:600;" }, f.summary),
          f.details ? h("div", { class: "sub", style: "margin-top:4px;" }, f.details) : null,
          f.user_words ? h("div", { class: "sub", style: "margin-top:4px; font-style:italic;" }, "“" + f.user_words + "”") : null),
        h("td", {}, f.user_id
          ? h("a", { href: "#/user/" + f.user_id }, f.name || f.email || "#" + f.user_id)
          : h("span", { class: "faint" }, "—"),
          h("div", { class: "sub" }, [f.source, f.app_build ? "build " + f.app_build : ""].filter(Boolean).join(" · "))),
        h("td", {}, actions));
    });
    if (!append) body.replaceChildren();
    if (rows.length) body.append(...rows);
    else if (!append) body.append(h("tr", {}, h("td", { colspan: 5, class: "chart-empty" },
      status === "new" ? "No new feedback — all caught up." : "Nothing here.")));
    moreBtn.disabled = d.feedback.length < 50;
  }
  moreBtn.addEventListener("click", () => { offset += 50; load(true).catch((e) => toast(e.message, true)); });

  const search = h("input", {
    class: "input", style: "max-width:240px;", placeholder: "Search feedback…",
    oninput: debounce((e) => { q = e.target.value.trim(); offset = 0; load(false).catch((x) => toast(x.message, true)); }, 300),
  });

  shell("#/feedback", h("div", {},
    h("div", { class: "page-head" },
      h("div", {}, h("div", { class: "page-title" }, "Feedback"),
        h("div", { class: "page-sub" }, "What the assistant reported about the app — bugs, missing features, complaints and ideas from users' conversations.")),
      h("div", { style: "display:flex; gap:8px; align-items:center;" }, tabs, search)),
    h("div", { class: "card table-card" },
      h("table", {},
        h("thead", {}, h("tr", {}, h("th", {}, "When"), h("th", {}, "Type"), h("th", {}, "Feedback"), h("th", {}, "From"), h("th", {}, ""))),
        body),
      moreBtn)));
  await load(false);
}

/* ------------------------------------------------------------------ */
/* Task outcomes — success / failure of what users asked for            */
/* ------------------------------------------------------------------ */

const OUTCOME_LABEL = {
  requested: "Requested", dialing: "Dialing", connected: "Connected", unconfirmed: "Unconfirmed",
  completed: "Completed", no_answer: "No answer", failed: "Failed", cancelled: "Cancelled",
};
function outcomePill(status) {
  const ok = status === "connected" || status === "completed";
  const bad = status === "failed" || status === "no_answer" || status === "cancelled";
  const color = ok ? "#15803d" : bad ? "#b91c1c" : status === "unconfirmed" ? "#b45309" : "#475569";
  const bg = ok ? "rgba(21,128,61,.12)" : bad ? "rgba(185,28,28,.12)" : status === "unconfirmed" ? "rgba(180,83,9,.12)" : "rgba(71,85,105,.12)";
  return h("span", { style: `display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:600;color:${color};background:${bg};` }, OUTCOME_LABEL[status] || status);
}

async function viewOutcomes() {
  shell("#/outcomes", loading());
  let q = "", status = "", kind = "", offset = 0;
  const body = h("tbody", {});
  const summaryRow = h("div", { style: "display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px;margin-bottom:16px;" });
  const moreBtn = h("button", { class: "btn", style: "margin:12px;" }, "Load more");

  function kpi(label, value, tone) {
    return h("div", { class: "card", style: "padding:14px 16px;" },
      h("div", { class: "sub", style: "font-size:12px;" }, label),
      h("div", { style: `font-size:24px;font-weight:700;${tone ? "color:" + tone + ";" : ""}` }, String(value)));
  }

  async function load(append) {
    const d = await api(`/outcomes?q=${encodeURIComponent(q)}&status=${status}&kind=${kind}&offset=${offset}&limit=50&days=30`);
    if (!append) {
      const s = d.summary || {};
      summaryRow.replaceChildren(
        kpi("Tasks (30d)", s.total || 0),
        kpi("Succeeded", s.succeeded || 0, "#15803d"),
        kpi("Failed", s.failed || 0, "#b91c1c"),
        kpi("Unconfirmed", s.unconfirmed || 0, "#b45309"),
        kpi("Pending", s.pending || 0));
    }
    const rows = d.outcomes.map((x) =>
      h("tr", {},
        h("td", { class: "sub", style: "white-space:nowrap;" }, timeAgo(x.updatedAt)),
        h("td", {}, x.userId ? h("a", { href: "#/user/" + x.userId }, x.userName || "#" + x.userId) : h("span", { class: "faint" }, "—")),
        h("td", {}, x.kind === "agent_call" ? "Relay call" : x.kind === "call" ? "Phone call" : x.kind === "document" ? "Document" : x.kind),
        h("td", {}, x.target || h("span", { class: "faint" }, "—")),
        h("td", {}, outcomePill(x.status)),
        h("td", { class: "sub" }, [x.reason, x.detail].filter(Boolean).join(" · "))));
    if (!append) body.replaceChildren();
    if (rows.length) body.append(...rows);
    else if (!append) body.append(h("tr", {}, h("td", { colspan: 6, class: "chart-empty" }, "No tasks recorded yet.")));
    moreBtn.disabled = d.outcomes.length < 50;
  }
  moreBtn.addEventListener("click", () => { offset += 50; load(true).catch((e) => toast(e.message, true)); });

  const reload = () => { offset = 0; load(false).catch((x) => toast(x.message, true)); };
  const search = h("input", {
    class: "input", style: "max-width:240px;", placeholder: "Filter by contact, reason…",
    oninput: debounce((e) => { q = e.target.value.trim(); reload(); }, 300),
  });
  const sel = (opts, onchange) =>
    h("select", { class: "input", style: "max-width:170px;", onchange: (e) => onchange(e.target.value) },
      ...opts.map(([v, l]) => h("option", { value: v }, l)));
  const statusSel = sel([["", "All statuses"], ["failed", "Failed"], ["no_answer", "No answer"], ["unconfirmed", "Unconfirmed"],
    ["connected", "Connected"], ["completed", "Completed"], ["dialing", "Dialing"], ["requested", "Requested"]], (v) => { status = v; reload(); });
  const kindSel = sel([["", "All kinds"], ["call", "Phone calls"], ["agent_call", "Relay calls"], ["document", "Documents"]], (v) => { kind = v; reload(); });

  shell("#/outcomes", h("div", {},
    h("div", { class: "page-head" },
      h("div", {}, h("div", { class: "page-title" }, "Task outcomes"),
        h("div", { class: "page-sub" }, "Calls and saved documents, and what actually happened — as reported by the phone and the telephony provider. ",
          h("a", { href: "#/live" }, "Every other action (messages, reminders, orders, searches, refusals) is in Live →"))),
      h("div", { style: "display:flex; gap:8px; flex-wrap:wrap;" }, search, statusSel, kindSel)),
    summaryRow,
    h("div", { class: "card table-card" },
      h("table", {},
        h("thead", {}, h("tr", {}, h("th", {}, "When"), h("th", {}, "User"), h("th", {}, "Kind"), h("th", {}, "Target"), h("th", {}, "Result"), h("th", {}, "Reason / detail"))),
        body),
      moreBtn)));
  await load(false);
}

/* ------------------------------------------------------------------ */
/* Broadcast                                                           */
/* ------------------------------------------------------------------ */

async function viewBroadcast() {
  shell("#/broadcast", loading());
  const d = await api("/users?limit=100");

  const title = h("input", { class: "input", placeholder: "e.g. New feature: video calls" });
  const msg = h("textarea", { class: "input", rows: 4, placeholder: "The notification text the phone will show." });
  const result = h("div", { class: "muted", style: "margin-top:12px;" });

  // Recipients: everyone, or hand-picked. Ticking any user flips the mode
  // to "selected" so the choice is always visible, never implicit.
  const allRadio = h("input", { type: "radio", name: "notify-target", checked: true });
  const someRadio = h("input", { type: "radio", name: "notify-target" });
  const boxes = new Map(); // user id -> checkbox
  const userRows = d.users.map((u) => {
    const cb = h("input", { type: "checkbox", onchange: () => { someRadio.checked = true; } });
    boxes.set(u.id, cb);
    return h("label", { class: "notify-user" }, cb,
      h("span", {}, `${u.name || "Unnamed"} (#${u.id})`),
      u.has_device ? null : h("span", { class: "muted" }, " — no device registered"));
  });

  const OUTCOME_TEXT = {
    sent: "delivered",
    no_device: "no device registered — will not receive pushes",
    stale: "device token was stale (cleared; re-registers on next app open)",
    shared_device: "shares a phone with another recipient — delivered once",
    failed: "send failed",
  };

  const send = h("button", {
    class: "btn primary", style: "margin-top:14px;", onclick: async () => {
      if (!title.value.trim() || !msg.value.trim()) return toast("Title and message required.", true);
      const targeted = someRadio.checked;
      const ids = targeted
        ? [...boxes.entries()].filter(([, cb]) => cb.checked).map(([id]) => id)
        : null;
      if (targeted && !ids.length) return toast("Pick at least one user, or choose All users.", true);
      const who = targeted ? `${ids.length} selected user${ids.length === 1 ? "" : "s"}` : "EVERY registered device";
      if (!confirm(`Send this notification to ${who}?\n\n${title.value}\n${msg.value}`)) return;
      send.disabled = true;
      try {
        const r = await api("/broadcast", {
          method: "POST",
          body: { title: title.value, body: msg.value, ...(targeted && { userIds: ids }) },
        });
        if (r.results) {
          result.replaceChildren(...r.results.map((u) =>
            h("div", { class: u.outcome === "sent" ? "" : "warn-text" },
              `${u.name}: ${u.error || OUTCOME_TEXT[u.outcome] || u.outcome}`)));
        } else {
          const bits = [`Delivered to ${r.sent} of ${r.devices} device${r.devices === 1 ? "" : "s"}`];
          if (r.stale) bits.push(`${r.stale} stale device${r.stale === 1 ? "" : "s"} cleared (re-register on next app open)`);
          if (r.failed) bits.push(`${r.failed} failed`);
          result.textContent = bits.join(" · ") + ".";
        }
        toast(r.sent ? "Notification sent." : "No deliveries — see the result lines.", !r.sent);
      } catch (e) { toast(e.message, true); }
      send.disabled = false;
    },
  }, "Send notification");

  shell("#/broadcast", h("div", {},
    pageHead("Notifications", "Send a custom push notification to all users or just the ones you pick."),
    h("div", { class: "card", style: "max-width:560px;" },
      h("div", { class: "field" }, h("label", {}, "Title"), title),
      h("div", { class: "field" }, h("label", {}, "Message"), msg),
      h("div", { class: "field" }, h("label", {}, "Recipients"),
        h("label", { class: "notify-mode" }, allRadio, h("span", {}, `All users (${d.total})`)),
        h("label", { class: "notify-mode" }, someRadio, h("span", {}, "Selected users:")),
        h("div", { class: "notify-user-list" }, userRows)),
      send, result)));
}

/* ------------------------------------------------------------------ */
/* Feature flags                                                       */
/* ------------------------------------------------------------------ */

const FLAG_DESC = {
  voice_mode: "Speak in → spoken reply out.",
  morning_briefing: "Automatic morning brief push.",
  face_mode: "Video avatar entry points in the app.",
  face_interview: "Face-to-face interview mode.",
  video_briefing: "Video versions of the daily brief.",
  photo_questions: "Photo & receipt questions via the camera.",
  live_info_cards: "Live info cards during conversation.",
  agent_calls: "Assistant-placed phone calls (auto-on when telephony works).",
};

async function viewFlags() {
  shell("#/flags", loading());
  const d = await api("/flags");
  const state = { ...d.defaults, ...d.overrides };

  const rows = Object.keys(d.defaults).map((k) => {
    const input = h("input", { type: "checkbox", checked: state[k], onchange: (e) => { state[k] = e.target.checked; } });
    return h("div", { class: "flag-row" },
      h("div", {},
        h("div", { class: "name" }, k),
        h("div", { class: "desc" }, (FLAG_DESC[k] || "") + "  (default: " + (d.defaults[k] ? "on" : "off") + ")")),
      h("label", { class: "switch" }, input, h("span", { class: "track" })));
  });

  const ann = h("textarea", { class: "input", rows: 2, placeholder: "Shown inside the app on launch. Leave empty for none." });
  if (d.announcement) ann.value = d.announcement;
  const force = h("input", { class: "input", type: "number", value: d.forceUpdateBelow || 0, style: "max-width:140px;" });

  const save = h("button", {
    class: "btn primary", onclick: async () => {
      try {
        await api("/flags", { method: "PUT", body: {
          features: state, announcement: ann.value.trim() || null,
          forceUpdateBelow: parseInt(force.value, 10) || 0,
        }});
        toast("Saved — apps pick this up on next launch.");
      } catch (e) { toast(e.message, true); }
    },
  }, "Save changes");

  const apk = d.apk;
  shell("#/flags", h("div", {},
    pageHead("Feature flags", "Flip features for every installed app instantly — no redeploy, no store release.", save),
    h("div", { class: "grid three-col" },
      h("div", { class: "card" }, h("h3", {}, "Features"), ...rows),
      h("div", {},
        h("div", { class: "card" },
          h("h3", {}, "Announcement"),
          h("div", { class: "field" }, ann),
          h("h3", { style: "margin-top:16px;" }, "Force update below version code"),
          h("div", { class: "field" }, force),
          h("div", { class: "faint", style: "font-size:12px;" }, "0 = never force. Installs older than this version code must update before continuing.")),
        h("div", { class: "card section-gap" },
          h("h3", {}, "Published APK"),
          apk ? [
            h("div", { class: "stat-mini" }, h("span", { class: "k" }, "Version"), h("span", { class: "v" }, apk.versionName + " (" + apk.versionCode + ")")),
            h("div", { class: "stat-mini" }, h("span", { class: "k" }, "Size"), h("span", { class: "v" }, Math.round((apk.size || 0) / 1048576) + " MB")),
          ] : h("div", { class: "faint" }, "No APK published on the self-hosted channel yet."))))));
}

/* ------------------------------------------------------------------ */
/* Debug                                                               */
/* ------------------------------------------------------------------ */

/** What Delete user removed, in words, for the alert after it. */
function erasedSummary(id, r) {
  const rows = Object.entries(r.rows || {}).sort((a, b) => b[1] - a[1]);
  const files = r.files || {};
  const lines = [
    `User #${id} deleted.`,
    "",
    `${r.totalRows || 0} database rows removed from ${rows.length} tables.`,
    `${r.totalFiles || 0} files removed (${files.recordings || 0} recording, ${files.documents || 0} document, ` +
      `${files.media || 0} video-note).`,
    `Google access: ${(r.revoked && r.revoked.google) || "—"}.`,
  ];
  if (r.revoked && r.revoked.liveSessions > 0) {
    lines.push(`Conversations in progress, ended: ${r.revoked.liveSessions}.`);
  }
  if (rows.length) {
    lines.push("");
    for (const [t, n] of rows.slice(0, 15)) lines.push(`  ${t}: ${n}`);
    if (rows.length > 15) lines.push(`  …and ${rows.length - 15} more tables`);
  }
  return lines.join("\n");
}

/**
 * LEFTOVERS — rows and files of accounts that no longer exist.
 *
 * Owner, 2026-09-25: "i ran but db files have not yet deleted". Deletes
 * before that date left recordings, conversations and document files
 * behind; this card counts them and removes them in one go, after a
 * confirm() that states the numbers.
 */
function leftoversCard() {
  const title = (hint) => h("h3", {}, "Leftovers from deleted accounts ",
    h("span", { class: "hint" }, hint));
  const card = h("div", { class: "card section-gap" }, title("checking…"));
  const line = (k, v) => h("div", { class: "stat-mini" },
    h("span", { class: "k" }, k), h("span", { class: "v" }, String(v)));

  async function load() {
    const d = await api("/maintenance/orphans");
    const f = d.files || {};
    const rows = Object.entries(d.tables || {}).sort((a, b) => b[1] - a[1]);
    const recFiles = (f.recordingFiles || 0) + (f.strayRecordingFiles || 0);
    const anything = d.totalRows > 0 || d.totalFiles > 0 || f.documentFolders > 0 ||
      f.mediaFolders > 0;

    const btn = h("button", {
      class: "btn danger", disabled: !anything, onclick: async () => {
        const msg =
          "Remove everything left behind by deleted accounts?\n\n" +
          `${d.totalRows} database rows in ${rows.length} tables\n` +
          `${recFiles} call recording files\n` +
          `${f.documentFiles || 0} document files in ${f.documentFolders || 0} folders\n` +
          `${f.mediaFiles || 0} video-note files in ${f.mediaFolders || 0} folders\n\n` +
          "None of it belongs to an account that still exists. This cannot be undone.";
        if (!confirm(msg)) return;
        btn.disabled = true;
        try {
          const r = await api("/maintenance/orphans/purge", { method: "POST" });
          toast(`Removed ${r.totalRows} rows and ${r.totalFiles} files.`);
          await load();
        } catch (e) {
          btn.disabled = false;
          toast(e.message, true);
        }
      },
    }, "Remove leftovers");

    // replaceChildren() would print a null as the word "null": filter first.
    card.replaceChildren(...[
      title(anything ? "rows and files whose account no longer exists" : "nothing left behind"),
      ...rows.map(([t, n]) => line(t, n)),
      anything ? line("call recording files", recFiles) : null,
      anything ? line("document files", `${f.documentFiles || 0} in ${f.documentFolders || 0} folders`) : null,
      // Identity videos and kept clips (storage/media.js), 2026-09-26.
      anything ? line("video-note files", `${f.mediaFiles || 0} in ${f.mediaFolders || 0} folders`) : null,
      h("div", { style: "margin-top:12px;" }, btn),
    ].filter(Boolean));
  }
  load().catch((e) => card.replaceChildren(title("could not check"),
    h("div", { class: "faint" }, e.message)));
  return card;
}

async function viewDebug(probe) {
  shell("#/debug", loading());
  const d = await api("/debug" + (probe ? "?probe=1" : ""));
  const s = d.server;

  const intRows = Object.entries(d.integrations).map(([k, ok]) => {
    const probeVal = d.probes[k.split("_")[0]];
    return h("div", { class: "stat-mini" },
      h("span", { class: "k" }, k.replace(/_/g, " ")),
      h("span", {},
        probeVal ? h("span", { class: "badge " + (String(probeVal).startsWith("ok") ? "good" : "danger"), style: "margin-right:6px;" }, String(probeVal)) : null,
        ok ? h("span", { class: "badge good" }, "configured") : h("span", { class: "badge neutral" }, "not set")));
  });

  const tableRows = Object.entries(d.tables).map(([t, n]) =>
    h("div", { class: "stat-mini" }, h("span", { class: "k" }, t), h("span", { class: "v" }, n)));

  const probeBtn = h("button", {
    class: "btn", onclick: () => viewDebug(true).catch((e) => toast(e.message, true)),
  }, "Run live probes");

  shell("#/debug", h("div", {},
    pageHead("System & debug", "Server health, integrations, and data volumes.", probeBtn),
    h("div", { class: "grid kpis" },
      kpi("DB latency", s.dbMs + " ms"),
      kpi("Uptime", fmtUptime(s.uptimeS)),
      kpi("Memory (RSS)", s.rssMb + " MB"),
      kpi("Heap used", s.heapMb + " MB"),
      kpi("Node", s.node),
      kpi("Environment", s.env)),
    h("div", { class: "grid two-col section-gap" },
      h("div", { class: "card" },
        h("h3", {}, "Integrations ",
          h("span", { class: "hint" }, probe ? "live probe results shown" : "key presence — press “Run live probes” to test them for real")),
        ...intRows),
      h("div", { class: "card" },
        h("h3", {}, "Table sizes"),
        ...tableRows,
        d.fulfillment.length ? [
          h("h3", { style: "margin-top:14px;" }, "Errands by status"),
          ...d.fulfillment.map((f) => h("div", { class: "stat-mini" },
            h("span", { class: "k" }, f.status), h("span", { class: "v" }, f.count))),
        ] : null)),
    leftoversCard()));
}

/* ------------------------------------------------------------------ */
/* Recordings — listen to the call, not just read it                    */
/* ------------------------------------------------------------------ */

const fmtLen = (ms) => {
  const s = Math.round((Number(ms) || 0) / 1000);
  const m = Math.floor(s / 60);
  return m ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`;
};

async function viewRecordings() {
  shell("#/recordings", loading());
  // #/recordings/28 narrows to one user; the plain hash shows everyone.
  const m = (location.hash || "").match(/^#\/recordings\/(\d+)/);
  const userId = m ? parseInt(m[1], 10) : 0;
  let offset = 0;
  const body = h("tbody", {});
  const moreBtn = h("button", { class: "btn", style: "margin:12px;" }, "Load more");
  const summary = h("div", { class: "page-sub" }, "");

  function row(r) {
    // preload="none" matters: without it, opening this page would pull
    // down every recording on it at once.
    const player = h("audio", {
      controls: "controls", preload: "none", style: "width:260px;height:34px;",
      src: `/admin-panel/api/recordings/${r.id}/audio`,
    });
    const tr = h("tr", {},
      h("td", { class: "sub", style: "white-space:nowrap;" },
        h("div", {}, fmtDate(r.started_at)),
        h("div", { class: "faint" }, timeAgo(r.started_at))),
      h("td", {}, r.user_id && r.user_exists === false
        // Left behind by an older delete; System & debug → Leftovers removes it.
        ? h("a", { class: "faint", href: "#/debug" }, "#" + r.user_id + " · deleted account")
        : r.user_id
          ? h("a", { href: "#/user/" + r.user_id }, r.user_name || "#" + r.user_id)
          : h("span", { class: "faint" }, "—")),
      h("td", { style: "white-space:nowrap;" }, fmtLen(r.duration_ms)),
      h("td", { class: "sub" }, r.format === "wav"
        ? h("div", { style: "max-width:360px;" },
            h("div", {}, h("span", { class: "faint" }, "User: "), r.question || "—"),
            h("div", { class: "sub" }, h("span", { class: "faint" }, "Assistant: "), r.answer || "—"))
        : String(r.turns || 0)),
      h("td", { class: "sub", style: "white-space:nowrap;" }, fmtBytes(r.bytes)),
      h("td", {}, player),
      h("td", { style: "white-space:nowrap;" },
        h("a", { class: "btn", href: `/admin-panel/api/recordings/${r.id}/audio`,
                 download: `${r.format === "wav" ? "turn" : "call"}-${r.id}.${r.format === "wav" ? "wav" : "m4a"}` }, "Download"),
        " ",
        h("button", {
          class: "btn danger",
          onclick: async (e) => {
            if (!confirm("Delete this recording? The audio file is removed from the server.")) return;
            e.target.disabled = true;
            try {
              // Stop playback first: a browser holding the file open
              // keeps requesting ranges from something already deleted.
              player.pause();
              player.removeAttribute("src");
              player.load();
              await api(`/recordings/${r.id}`, { method: "DELETE" });
              tr.remove();
              toast("Recording deleted.");
            } catch (err) {
              e.target.disabled = false;
              toast(err.message, true);
            }
          },
        }, "Delete")));
    return tr;
  }

  async function load(append) {
    const d = await api(`/recordings?user_id=${userId || ""}&offset=${offset}&limit=50`);
    if (!append) body.replaceChildren();
    const rows = d.recordings.map(row);
    if (rows.length) body.append(...rows);
    else if (!append) {
      body.append(h("tr", {}, h("td", { colspan: 7, class: "chart-empty" },
        "No recordings yet. They appear here once a voice session ends.")));
    }
    if (d.usage) {
      summary.replaceChildren(document.createTextNode(
        `${d.usage.count} call${d.usage.count === 1 ? "" : "s"} · ` +
        `${fmtLen(d.usage.ms)} of audio · ${fmtBytes(d.usage.bytes)} on disk · ` +
        `kept ${d.usage.keepDays} days` +
        (d.usage.failed ? ` · ${d.usage.failed} failed` : "") +
        (d.usage.enabled ? "" : " · RECORDING IS OFF")));
    }
    moreBtn.disabled = d.recordings.length < 50;
  }
  moreBtn.addEventListener("click", () => {
    offset += 50;
    load(true).catch((e) => toast(e.message, true));
  });

  shell("#/recordings", h("div", {},
    h("div", { class: "page-head" },
      h("div", {},
        h("div", { class: "page-title" },
          userId ? "Recordings for #" + userId : "Recordings"),
        summary),
      userId ? h("a", { class: "btn", href: "#/recordings" }, "All users") : null),
    h("div", { class: "card table-card" },
      h("table", {},
        h("thead", {}, h("tr", {},
          h("th", {}, "When"), h("th", {}, "User"), h("th", {}, "Length"),
          h("th", {}, "Turns / words"), h("th", {}, "Size"), h("th", {}, "Listen"),
          h("th", {}, ""))),
        body),
      moreBtn)));
  await load(false);
}

/* ------------------------------------------------------------------ */
/* Video notes — made by hand in Colab, delivered from here             */
/* ------------------------------------------------------------------ */
//
// Owner, 2026-09-26: the sender's 30-second video + the script → the
// talking clip in Colab → upload it here, and it reaches the recipient.
// Uploading IS delivering: there is no second button to forget.

const NOTE_STATUS = {
  pending: ["Waiting", "warn"],
  generated: ["Made — not delivered", "danger"],
  delivered: ["Delivered", "good"],
  failed: ["Failed", "danger"],
  cancelled: ["Cancelled", "neutral"],
};

async function viewVideoNotes() {
  shell("#/video-notes", loading());
  let status = "pending", offset = 0;
  const body = h("tbody", {});
  const moreBtn = h("button", { class: "btn", style: "margin:12px;" }, "Load more");
  const tabs = h("div", { style: "display:flex; gap:8px; flex-wrap:wrap;" });

  function drawTabs(c) {
    const tab = (value, label) => h("button", {
      class: "btn sm" + (status === value ? " primary" : ""),
      onclick: () => { status = value; offset = 0; load(false).catch((e) => toast(e.message, true)); },
    }, label);
    tabs.replaceChildren(
      tab("pending", `Waiting (${c.pending})`),
      tab("generated", `Made (${c.generated})`),
      tab("delivered", `Delivered (${c.delivered})`),
      tab("failed", `Failed (${c.failed})`),
      tab("cancelled", `Cancelled (${c.cancelled})`),
      tab("", "All"));
  }

  const reload = () => { offset = 0; return load(false).catch((e) => toast(e.message, true)); };

  function actions(r) {
    const box = h("div", { style: "display:flex; gap:6px; flex-wrap:wrap; justify-content:flex-end;" });
    // Waiting or failed AND the sender consents right now (the server
    // refuses the rest anyway): nothing here uses a face they took back.
    const open = r.workable;
    if (open && r.hasSource) {
      box.append(h("a", {
        class: "btn sm", href: `/admin-panel/api/video-notes/${r.id}/source?download=1`,
        download: `note-${r.id}-sender.mp4`,
      }, "Download video"));
    }
    box.append(h("button", {
      class: "btn sm",
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(r.script);
          toast("Script copied.");
        } catch (_) {
          prompt("Copy the script:", r.script);
        }
      },
    }, "Copy script"));
    if (open && r.hasSource && !r.identityChecked) {
      // THE CHECKPOINT. The server cannot tell a live take from any MP4 a
      // client posts; the person watching it can. Nothing can be uploaded
      // for this note until this is confirmed.
      box.append(h("button", {
        class: "btn sm",
        onclick: async (e) => {
          const who = r.sender.name || "the sender";
          const said = r.teleprompter
            ? `“${r.teleprompter.consent}”`
            : `the consent sentence the app showed (script v${r.scriptVersion})`;
          if (!confirm(
            `Watch the video first.\n\nI watched it: the person in it is ${who}, the account ` +
            `holder, and they read the consent sentence out loud:\n\n${said}\n\nConfirm?`)) return;
          e.target.disabled = true;
          try {
            await api(`/video-notes/${r.id}/verify`, { method: "POST", body: { confirm: true } });
            toast("Checked — you can upload the clip now.");
            await reload();
          } catch (err) { e.target.disabled = false; toast(err.message, true); }
        },
      }, "It's them"));
    }
    if (open) {
      const file = h("input", { type: "file", accept: "video/mp4,video/quicktime,.mp4,.mov", style: "display:none;" });
      const btn = h("button", {
        class: "btn sm primary",
        disabled: r.identityChecked ? null : "disabled",
        title: r.identityChecked ? null : "Watch the sender's video and confirm it's them first",
      }, "Upload result");
      btn.addEventListener("click", () => file.click());
      file.addEventListener("change", async () => {
        const f = file.files && file.files[0];
        if (!f) return;
        const who = r.recipient.onApp ? r.recipient.name : `${r.sender.name || "the sender"} (to share)`;
        if (!confirm(`Deliver "${f.name}" (${fmtBytes(f.size)}) to ${who} now?`)) { file.value = ""; return; }
        const form = new FormData();
        form.append("file", f);
        btn.disabled = true;
        try {
          const d = await upload(`/video-notes/${r.id}/result`, form, (sent, total) => {
            btn.textContent = `Uploading ${Math.round((sent / total) * 100)}%`;
          });
          toast(d.deliveredTo === "recipient" ? "Delivered to their app." : "Saved for the sender to share.");
          await reload();
        } catch (e) {
          btn.disabled = false;
          btn.textContent = "Upload result";
          file.value = "";
          toast(e.message, true);
        }
      });
      box.append(btn, file);
    }
    if (r.status === "generated" && r.sender.consent === "ok") {
      box.append(h("button", {
        class: "btn sm primary",
        onclick: async (e) => {
          e.target.disabled = true;
          try {
            await api(`/video-notes/${r.id}/deliver`, { method: "POST" });
            toast("Delivered.");
            await reload();
          } catch (err) { e.target.disabled = false; toast(err.message, true); }
        },
      }, "Retry delivery"));
    }
    if (r.status === "pending" || r.status === "generated") {
      box.append(h("button", {
        class: "btn sm danger",
        onclick: async () => {
          const reason = prompt("Why couldn't it be made? The sender is told it couldn't be made.", "");
          if (reason === null) return;
          try {
            await api(`/video-notes/${r.id}/fail`, { method: "POST", body: { reason } });
            toast("Marked failed.");
            await reload();
          } catch (e) { toast(e.message, true); }
        },
      }, "Mark failed"));
    }
    return box;
  }

  const CONSENT_BADGE = {
    withdrawn: ["withdrew consent", "danger"],
    off: ["switched video notes off", "warn"],
  };

  /**
   * What the owner checks before making anything: the sender's own video,
   * played here, beside the words the app asked them to read — the first
   * of which is the consent sentence.
   */
  function sourceCheck(r) {
    if (!r.workable || !r.hasSource) return null;
    const tp = r.teleprompter;
    return h("div", { style: "margin-top:8px; max-width:260px;" },
      h("video", {
        controls: "controls", preload: "none", style: "width:220px; max-height:160px;",
        src: `/admin-panel/api/video-notes/${r.id}/source`,
      }),
      tp
        ? h("div", { class: "sub", style: "margin-top:4px;" },
            "Should open with: ", h("strong", {}, `“${tp.consent}”`))
        : h("div", { class: "sub", style: "margin-top:4px; color:var(--danger);" },
            `Script v${r.scriptVersion} is not one this server knows — check the consent sentence by ear.`),
      tp
        ? h("details", {}, h("summary", { class: "sub" }, `Everything they were asked to read (v${r.scriptVersion})`),
            h("div", { class: "sub" }, tp.text))
        : null,
      h("span", { class: "badge " + (r.identityChecked ? "good" : "warn"), style: "margin-top:4px;" },
        r.identityChecked ? `checked it's them ${timeAgo(r.identityCheckedAt)}` : "not checked yet"));
  }

  function row(r) {
    const [label, tone] = NOTE_STATUS[r.status] || [r.status, "neutral"];
    const player = r.hasOutput
      // preload="none": a page of notes must not pull down every clip.
      ? h("video", {
          controls: "controls", preload: "none", style: "width:180px; max-height:120px; margin-top:6px;",
          src: `/admin-panel/api/video-notes/${r.id}/output`,
        })
      : null;
    const consent = CONSENT_BADGE[r.sender.consent];
    return h("tr", {},
      h("td", { class: "sub", style: "white-space:nowrap;" },
        h("div", {}, fmtDate(r.createdAt)),
        h("div", { class: "faint" }, timeAgo(r.createdAt))),
      h("td", {},
        r.sender.id
          ? h("a", { href: "#/user/" + r.sender.id }, r.sender.name || "#" + r.sender.id)
          : h("span", { class: "faint" }, "—"),
        h("div", { class: "sub" }, r.sender.phone || ""),
        r.hasSource ? h("div", { class: "sub" }, "video " + fmtBytes(r.sourceBytes))
          : h("div", { class: "sub" }, "no video on file"),
        consent ? h("span", { class: "badge " + consent[1] }, consent[0]) : null,
        sourceCheck(r)),
      h("td", {},
        h("div", {}, r.recipient.name || "—"),
        h("div", { class: "sub" }, r.recipient.phone || ""),
        h("span", { class: "badge " + (r.recipient.onApp ? "accent" : "neutral") },
          r.recipient.onApp ? "on the app" : "not on the app")),
      h("td", { style: "max-width:360px;" },
        h("div", {}, r.script),
        r.language ? h("div", { class: "sub" }, r.language) : null),
      h("td", {},
        h("span", { class: "badge " + tone }, label),
        r.note ? h("div", { class: "sub", style: "margin-top:4px;" }, r.note) : null,
        r.error ? h("div", { class: "sub", style: "margin-top:4px; color:var(--danger);" }, r.error) : null,
        player),
      h("td", {}, actions(r)));
  }

  async function load(append) {
    const d = await api(`/video-notes?status=${status}&offset=${offset}&limit=50`);
    drawTabs(d.counts);
    if (!append) body.replaceChildren();
    const rows = d.renders.map(row);
    if (rows.length) body.append(...rows);
    else if (!append) {
      body.append(h("tr", {}, h("td", { colspan: 6, class: "chart-empty" },
        status === "pending" ? "No video notes waiting." : "Nothing here.")));
    }
    moreBtn.disabled = d.renders.length < 50;
  }
  moreBtn.addEventListener("click", () => { offset += 50; load(true).catch((e) => toast(e.message, true)); });

  shell("#/video-notes", h("div", {},
    h("div", { class: "page-head" },
      h("div", {},
        h("div", { class: "page-title" }, "Video notes"),
        h("div", { class: "page-sub" },
          "Watch the sender's video first: it must be the account holder reading the consent " +
          "sentence shown beside it. Confirm that, download the video and copy the script, make " +
          "the clip, then upload it — it is delivered the moment the upload finishes. Clips are " +
          "labelled as AI-made for the recipient.")),
      tabs),
    h("div", { class: "card table-card" },
      h("table", {},
        h("thead", {}, h("tr", {},
          h("th", {}, "Asked"), h("th", {}, "From"), h("th", {}, "To"),
          h("th", {}, "Script"), h("th", {}, "Status"), h("th", {}, ""))),
        body),
      moreBtn)));
  await load(false);
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

window.addEventListener("hashchange", render);
(async () => {
  try {
    await api("/session");
    render();
  } catch (_) {
    /* showLogin already called by api() on 401 */
  }
})();
