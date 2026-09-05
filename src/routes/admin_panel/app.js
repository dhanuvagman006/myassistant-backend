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
    headers: opts.body ? { "Content-Type": "application/json" } : {},
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
    svg.append(svgEl("line", { x1: padL, y1: y, x2: W - 4, y2: y, stroke: "#f0f0f2", "stroke-width": 1 }));
    const lbl = svgEl("text", { x: padL - 6, y: y + 4, "text-anchor": "end", "font-size": 10, fill: "#9ca3af" });
    lbl.textContent = String(Math.round(frac * max));
    svg.append(lbl);
  }
  series.forEach((s, i) => {
    const x = padL + i * (plotW / n) + gap / 2;
    const bh = Math.max(s.count > 0 ? 3 : 1, (s.count / max) * plotH);
    const y = padT + plotH - bh;
    const r = svgEl("rect", {
      x, y, width: bw, height: bh, rx: 2,
      fill: s.count > 0 ? "#4f46e5" : "#e5e7eb",
    });
    r.addEventListener("mousemove", (ev) => showTip(ev, dayLabel(s.d), s.count));
    r.addEventListener("mouseleave", hideTip);
    svg.append(r);
  });
  // sparse x labels: first, middle, last
  for (const i of [0, Math.floor(n / 2), n - 1]) {
    const x = padL + i * (plotW / n) + bw / 2;
    const t = svgEl("text", { x, y: H - 5, "text-anchor": "middle", "font-size": 10, fill: "#9ca3af" });
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
  const btn = h("button", { class: "btn primary", style: "width:100%; margin-top:6px;" }, "Sign in");
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

const NAV = [
  ["#/", "Overview"],
  ["#/users", "Users"],
  ["#/analytics", "Analytics"],
  ["#/activity", "Activity"],
  ["#/broadcast", "Broadcast"],
  ["#/flags", "Feature flags"],
  ["#/debug", "System & debug"],
];

function shell(activeHash, content) {
  const nav = NAV.map(([hash, label]) =>
    h("button", {
      class: "nav-item" + (hash === activeHash ? " active" : ""),
      onclick: () => { location.hash = hash; },
    }, label)
  );
  $app.replaceChildren(
    h("div", { class: "shell" },
      h("aside", { class: "sidebar" },
        h("div", { class: "brand" }, h("div", { class: "brand-mark" }, "M"), h("span", {}, "MyAssistant")),
        ...nav,
        h("div", { class: "spacer" }),
        h("button", {
          class: "nav-item", onclick: async () => {
            try { await api("/logout", { method: "POST" }); } catch (_) {}
            showLogin();
          },
        }, "Sign out")
      ),
      h("main", { class: "main" }, content)
    )
  );
}

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
    if (hash.startsWith("#/users")) return await viewUsers();
    if (hash.startsWith("#/analytics")) return await viewAnalytics();
    if (hash.startsWith("#/activity")) return await viewActivity();
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

async function viewOverview() {
  shell("#/", loading());
  const d = await api("/overview");
  const k = d.kpis, a = d.adoption, he = d.health;

  const feed = d.activity.length
    ? d.activity.map((x) => h("div", { class: "feed-item" },
        h("div", { class: "feed-dot" }),
        h("div", {},
          h("div", {}, h("span", { class: "who" }, x.name || "someone"),
            h("span", { class: "what" }, " · " + x.action)),
          h("div", { class: "when" }, (x.detail ? x.detail + " — " : "") + timeAgo(x.created_at)))))
    : [h("div", { class: "chart-empty" }, "No activity recorded yet.")];

  shell("#/", h("div", {},
    pageHead("Overview", "Live picture of the platform."),
    h("div", { class: "grid kpis" },
      kpi("Users", k.users, "+" + k.newWeek + " this week"),
      kpi("Active today", k.dau),
      kpi("Active · 7 days", k.wau),
      kpi("Actions · 24 h", k.actions24),
      kpi("Verified phones", k.verified),
      kpi("Devices w/ push", k.devices),
      kpi("Paused accounts", k.paused),
    ),
    h("div", { class: "grid two-col section-gap" },
      h("div", { class: "card" }, h("h3", {}, "Signups — last 14 days"), barChart(d.signups14)),
      h("div", { class: "card" }, h("h3", {}, "Actions — last 14 days"), barChart(d.actions14)),
    ),
    h("div", { class: "grid three-col section-gap" },
      h("div", { class: "card" },
        h("h3", {}, "Live activity ", h("span", { class: "hint" }, "audit trail, newest first")),
        ...feed),
      h("div", {},
        h("div", { class: "card" },
          h("h3", {}, "Feature adoption"),
          h("div", { class: "stat-mini" }, h("span", { class: "k" }, "Documents saved"), h("span", { class: "v" }, a.docs)),
          h("div", { class: "stat-mini" }, h("span", { class: "k" }, "Open reminders"), h("span", { class: "v" }, a.reminders)),
          h("div", { class: "stat-mini" }, h("span", { class: "k" }, "Open promises"), h("span", { class: "v" }, a.commitsOpen)),
          h("div", { class: "stat-mini" }, h("span", { class: "k" }, "Client case files"), h("span", { class: "v" }, a.clients)),
          h("div", { class: "stat-mini" }, h("span", { class: "k" }, "Messages relayed"), h("span", { class: "v" }, a.agentMsgs)),
          h("div", { class: "stat-mini" }, h("span", { class: "k" }, "Memories stored"), h("span", { class: "v" }, a.memories)),
          h("div", { class: "stat-mini" }, h("span", { class: "k" }, "Finance items"), h("span", { class: "v" }, a.financeItems))),
        h("div", { class: "card section-gap" },
          h("h3", {}, "Server"),
          h("div", { class: "stat-mini" }, h("span", { class: "k" }, "Database"), h("span", { class: "v" }, he.dbMs + " ms")),
          h("div", { class: "stat-mini" }, h("span", { class: "k" }, "Uptime"), h("span", { class: "v" }, fmtUptime(he.uptimeS))),
          h("div", { class: "stat-mini" }, h("span", { class: "k" }, "Memory"), h("span", { class: "v" }, he.rssMb + " MB")),
          h("div", { class: "stat-mini" }, h("span", { class: "k" }, "Node"), h("span", { class: "v" }, he.node))))
    )
  ));
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
        h("td", {}, u.has_device ? h("span", { class: "badge accent" }, "push ok")
                                 : h("span", { class: "faint" }, "no device")),
        h("td", {}, statusBadge(u)),
        h("td", { class: "sub" }, fmtDate(u.created_at))
      ));
    tableWrap.replaceChildren(
      h("table", {},
        h("thead", {}, h("tr", {},
          h("th", {}, "User"), h("th", {}, "Phone"), h("th", {}, "Provider"),
          h("th", {}, "Device"), h("th", {}, "Status"), h("th", {}, "Joined"))),
        h("tbody", {}, rows.length ? rows
          : h("tr", {}, h("td", { colspan: 6, class: "chart-empty" }, "No users match."))))
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
        `This permanently deletes user #${id} (${u.email || u.name || "no email"}) and ALL their data — documents, memories, reminders, everything. Type DELETE to confirm.`);
      if (typed !== "DELETE") return;
      try { await api("/users/" + id, { method: "DELETE" }); toast("User deleted."); location.hash = "#/users"; }
      catch (e) { toast(e.message, true); }
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
          saveBtn),
        h("div", { class: "card section-gap" },
          h("h3", {}, "Phone ", h("span", { class: "hint" }, "setting a number here also marks it verified")),
          u.phone_number ? h("div", { style: "margin-bottom:10px;" }, "Current: ", h("strong", {}, u.phone_number)) : null,
          h("div", { class: "inline-form" }, phoneInput, phoneBtn)),
        h("div", { class: "card section-gap" },
          h("h3", {}, "Recent activity"),
          d.recent.length ? d.recent.map((x) => h("div", { class: "feed-item" },
            h("div", { class: "feed-dot" }),
            h("div", {}, h("div", {}, x.action),
              h("div", { class: "when" }, (x.detail ? x.detail + " — " : "") + timeAgo(x.created_at)))))
            : h("div", { class: "chart-empty" }, "No recorded activity."))),
      h("div", {},
        h("div", { class: "card" },
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
/* Broadcast                                                           */
/* ------------------------------------------------------------------ */

async function viewBroadcast() {
  const title = h("input", { class: "input", placeholder: "e.g. New feature: video calls" });
  const msg = h("textarea", { class: "input", rows: 4, placeholder: "The notification text every user's phone will show." });
  const result = h("div", { class: "muted", style: "margin-top:12px;" });
  const send = h("button", {
    class: "btn primary", onclick: async () => {
      if (!title.value.trim() || !msg.value.trim()) return toast("Title and message required.", true);
      if (!confirm(`Send this notification to EVERY registered device?\n\n${title.value}\n${msg.value}`)) return;
      send.disabled = true;
      try {
        const r = await api("/broadcast", { method: "POST", body: { title: title.value, body: msg.value } });
        const bits = [`Delivered to ${r.sent} of ${r.devices} device${r.devices === 1 ? "" : "s"}`];
        if (r.stale) bits.push(`${r.stale} stale device${r.stale === 1 ? "" : "s"} cleared (re-register on next app open)`);
        if (r.failed) bits.push(`${r.failed} failed`);
        result.textContent = bits.join(" · ") + ".";
        toast(r.sent ? "Broadcast delivered." : "No deliveries — see the result line.", !r.sent);
      } catch (e) { toast(e.message, true); }
      send.disabled = false;
    },
  }, "Send to all devices");

  shell("#/broadcast", h("div", {},
    pageHead("Broadcast", "Push a notification to every user with the app installed."),
    h("div", { class: "card", style: "max-width:560px;" },
      h("div", { class: "field" }, h("label", {}, "Title"), title),
      h("div", { class: "field" }, h("label", {}, "Message"), msg),
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
  agent_calls: "Assistant-placed phone calls. Auto-detects telephony creds; an override set here wins (use as kill switch — creds alone don't prove two-way calling).",
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
        ok ? h("span", { class: "badge good" }, typeof ok === "string" ? ok : "configured")
           : h("span", { class: "badge neutral" }, "not set")));
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
        ] : null))));
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
