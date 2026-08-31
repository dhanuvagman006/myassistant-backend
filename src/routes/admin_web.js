/**
 * ADMIN PANEL — server-rendered dashboard at /admin-panel.
 *
 * Rewritten 2026-08-30: the previous version queried a `phone` column that
 * does not exist (the real column is phone_number), so the page returned
 * 500 on every load in production — and its guard read ADMIN_SECRET, which
 * no deployment sets, leaving it OPEN wherever it did render.
 *
 * Guard: ADMIN_KEY (the same env the /admin API uses). Provide it as
 * ?key=… on the first request; every form carries it forward as a hidden
 * field. Without ADMIN_KEY set, the panel refuses to serve at all — an
 * open admin panel is worse than none.
 *
 * Everything is real data: users (verified-phone badge, provider, status),
 * platform KPIs across the feature tables, a 14-day signup sparkline, and
 * the audit-trail activity feed. Admin actions: pause/resume/delete a
 * user, and attach+verify a phone number (the testing-phase equivalent of
 * OTP — see routes/phone.js dev-verify).
 */
const router = require("express").Router();
const db = require("../db");
const express = require("express");
const { normalizePhone } = require("../users/phone");

router.use(express.json());
router.use(express.urlencoded({ extended: false }));

/* ------------------------------------------------------------------ */
/* Guard                                                               */
/* ------------------------------------------------------------------ */

function adminGuard(req, res, next) {
  const key = process.env.ADMIN_KEY || "";
  if (!key) {
    return res.status(503).send(page("Admin panel disabled",
      `<p class="text-slate-400">Set <code>ADMIN_KEY</code> in the environment to enable the panel.</p>`));
  }
  const provided =
    req.query.key || req.headers["x-admin-key"] || req.body?.key || "";
  if (provided === key) return next();
  return res.status(401).send(page("Unauthorized",
    `<p class="text-slate-400">Open the panel as
     <code>/admin-panel?key=&lt;ADMIN_KEY&gt;</code>.</p>`));
}
router.use(adminGuard);

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const n = (rows) => parseInt(rows?.[0]?.count ?? 0, 10) || 0;

const fmtDate = (ms) => {
  const t = parseInt(ms, 10);
  if (!Number.isFinite(t) || !t) return "—";
  return new Date(t).toLocaleDateString("en-IN", {
    day: "2-digit", month: "short", year: "numeric",
  });
};

const timeAgo = (ms) => {
  const d = Date.now() - parseInt(ms, 10);
  if (!Number.isFinite(d) || d < 0) return "";
  const m = Math.floor(d / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
};

/** Base page shell (used for both the dashboard and error pages). */
function page(title, body) {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)} — Hari Admin</title>
<script src="https://cdn.tailwindcss.com"></script>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  * { font-family:'Inter',sans-serif; }
  body { background:#060810; }
  .glass { background:rgba(255,255,255,0.03); backdrop-filter:blur(20px); border:1px solid rgba(255,255,255,0.07); }
  .neon { color:#00F0FF; text-shadow:0 0 20px rgba(0,240,255,0.4); }
  ::-webkit-scrollbar { width:4px; height:4px; }
  ::-webkit-scrollbar-thumb { background:rgba(0,240,255,0.2); border-radius:4px; }
  input:focus { outline:none; border-color:rgba(0,240,255,0.5)!important; }
</style></head>
<body class="min-h-screen text-slate-200">
<div style="position:fixed;inset:0;pointer-events:none;z-index:0;">
  <div style="position:absolute;top:-200px;left:-100px;width:600px;height:600px;background:radial-gradient(circle,rgba(0,240,255,0.07) 0%,transparent 70%);border-radius:50%;"></div>
  <div style="position:absolute;bottom:-200px;right:-100px;width:700px;height:700px;background:radial-gradient(circle,rgba(123,95,255,0.06) 0%,transparent 70%);border-radius:50%;"></div>
</div>
<div class="relative z-10 max-w-7xl mx-auto px-6 py-10">${body}</div>
</body></html>`;
}

/** Count a table, returning 0 when it does not exist yet. */
async function safeCount(sql, params = []) {
  try {
    return n(await db.query(sql, params));
  } catch (_) {
    return 0;
  }
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

router.post("/action", async (req, res) => {
  const { action, id, phone, key } = req.body;
  const back = `/admin-panel?key=${encodeURIComponent(key || "")}`;
  try {
    if (action === "delete") {
      await db.query("DELETE FROM users WHERE id=$1", [id]);
    } else if (action === "pause") {
      await db.query("UPDATE users SET status='paused' WHERE id=$1", [id]);
    } else if (action === "resume") {
      await db.query("UPDATE users SET status='active' WHERE id=$1", [id]);
    } else if (action === "set_phone") {
      // Attach AND verify a number — the admin equivalent of OTP during
      // the testing phase. Same normalisation + uniqueness as the real
      // flow, so nothing filed under this number ever goes astray.
      const e164 = normalizePhone(phone);
      if (!e164) return res.redirect(back + "&error=" + encodeURIComponent("Invalid phone number"));
      const clash = await db.query(
        "SELECT id FROM users WHERE phone_number=$1 AND id<>$2", [e164, id]);
      if (clash.length) {
        return res.redirect(back + "&error=" + encodeURIComponent(
          `${e164} already belongs to user #${clash[0].id}`));
      }
      await db.query(
        "UPDATE users SET phone_number=$1, phone_verified_at=$2 WHERE id=$3",
        [e164, Date.now(), id]);
    }
    res.redirect(back);
  } catch (e) {
    res.redirect(back + "&error=" + encodeURIComponent(e.message));
  }
});

/* ------------------------------------------------------------------ */
/* Dashboard                                                           */
/* ------------------------------------------------------------------ */

router.get("/", async (req, res) => {
  const key = String(req.query.key || "");
  // Helmet's default CSP blocks the Tailwind CDN this page uses.
  res.setHeader("Content-Security-Policy",
    "default-src 'self'; script-src 'self' https://cdn.tailwindcss.com 'unsafe-inline'; " +
    "style-src 'self' https: 'unsafe-inline'; font-src 'self' https: data:; img-src 'self' data:;");
  try {
    const users = await db.query(
      `SELECT id, name, email, provider, created_at, status,
              phone_number, phone_verified_at,
              fcm_token IS NOT NULL AND fcm_token <> '' AS has_device
         FROM users ORDER BY created_at DESC LIMIT 200`);

    const weekAgo = Date.now() - 7 * 86400_000;
    const dayAgo = Date.now() - 86400_000;
    const [verified, newWeek, docs, reminders, commitsOpen, clients, notes,
           agentMsgs, memories, convMsgs, dau, wau, actions24, financeItems] =
      await Promise.all([
      safeCount("SELECT COUNT(*) AS count FROM users WHERE phone_verified_at IS NOT NULL"),
      safeCount("SELECT COUNT(*) AS count FROM users WHERE created_at > $1", [weekAgo]),
      safeCount("SELECT COUNT(*) AS count FROM documents"),
      safeCount("SELECT COUNT(*) AS count FROM reminders WHERE done=0"),
      safeCount("SELECT COUNT(*) AS count FROM commitments WHERE status='open'"),
      safeCount("SELECT COUNT(*) AS count FROM clients WHERE archived=0"),
      safeCount("SELECT COUNT(*) AS count FROM client_notes"),
      safeCount("SELECT COUNT(*) AS count FROM agent_messages"),
      safeCount("SELECT COUNT(*) AS count FROM agent_memories WHERE valid=1"),
      safeCount("SELECT COUNT(*) AS count FROM messages"),
      // Engagement — the numbers a company actually watches daily.
      safeCount("SELECT COUNT(DISTINCT user_id) AS count FROM actions_log WHERE created_at > $1", [dayAgo]),
      safeCount("SELECT COUNT(DISTINCT user_id) AS count FROM actions_log WHERE created_at > $1", [weekAgo]),
      safeCount("SELECT COUNT(*) AS count FROM actions_log WHERE created_at > $1", [dayAgo]),
      safeCount("SELECT COUNT(*) AS count FROM finance_items"),
    ]);

    // 14-day signup sparkline (created_at is epoch ms).
    let spark = "";
    try {
      const rows = await db.query(
        `SELECT to_char(to_timestamp(created_at/1000.0),'YYYY-MM-DD') AS d,
                COUNT(*) AS count
           FROM users WHERE created_at > $1 GROUP BY d`,
        [Date.now() - 14 * 86400_000]);
      const byDay = Object.fromEntries(rows.map((r) => [r.d, parseInt(r.count, 10)]));
      const days = [...Array(14)].map((_, i) => {
        const d = new Date(Date.now() - (13 - i) * 86400_000)
          .toISOString().slice(0, 10);
        return byDay[d] || 0;
      });
      const max = Math.max(1, ...days);
      const bars = days.map((v, i) =>
        `<rect x="${i * 16}" y="${36 - (v / max) * 32}" width="11" height="${(v / max) * 32 + 2}"
           rx="2" fill="${v ? "#00F0FF" : "rgba(255,255,255,0.08)"}" opacity="${v ? 0.85 : 1}"/>`
      ).join("");
      spark = `<svg width="224" height="40" viewBox="0 0 224 40">${bars}</svg>`;
    } catch (_) {}

    // Live activity feed from the audit trail.
    let activity = [];
    try {
      activity = await db.query(
        `SELECT a.action, a.detail, a.created_at, u.name
           FROM actions_log a LEFT JOIN users u ON u.id = a.user_id
          ORDER BY a.created_at DESC LIMIT 12`);
    } catch (_) {}

    const kpi = (label, value, color) => `
      <div class="glass p-5 rounded-2xl" style="border-left:3px solid ${color}">
        <p class="text-slate-500 text-[11px] font-semibold uppercase tracking-wider mb-2">${label}</p>
        <p class="text-3xl font-bold text-white">${value}</p>
      </div>`;

    const providerBadge = (p) => {
      const c = {
        google: "bg-blue-500/20 text-blue-300 border-blue-500/30",
        apple: "bg-slate-500/20 text-slate-300 border-slate-500/30",
        email: "bg-violet-500/20 text-violet-300 border-violet-500/30",
      }[p] || "bg-white/10 text-white/60 border-white/10";
      return `<span class="px-2 py-0.5 text-[10px] uppercase font-bold rounded-full border ${c}">${esc(p || "?")}</span>`;
    };

    const rowsHtml = users.map((u) => {
      const paused = u.status === "paused";
      const phone = u.phone_number
        ? `<span class="font-mono text-slate-300">${esc(u.phone_number)}</span>
           ${u.phone_verified_at
             ? `<span class="text-emerald-400 text-[10px] font-bold ml-1">✓ verified</span>`
             : `<span class="text-orange-400 text-[10px] font-bold ml-1">unverified</span>`}`
        : `<form method="POST" action="/admin-panel/action" class="flex items-center gap-1">
             <input type="hidden" name="action" value="set_phone">
             <input type="hidden" name="id" value="${u.id}">
             <input type="hidden" name="key" value="${esc(key)}">
             <input type="tel" name="phone" placeholder="attach number…"
               class="bg-white/5 border border-white/10 text-slate-200 placeholder-slate-600 text-xs rounded-lg px-2 py-1 w-32">
             <button class="text-cyan-300 border border-cyan-500/30 hover:bg-cyan-500/10 text-[10px] font-bold px-2 py-1 rounded-lg">SET</button>
           </form>`;
      const initials = (u.name || u.email || "?")
        .split(/\s+/).map((x) => x[0]).join("").toUpperCase().slice(0, 2);
      const colors = ["bg-violet-600","bg-cyan-600","bg-pink-600","bg-emerald-600","bg-amber-600"];
      return `
        <tr class="border-b border-white/5 hover:bg-white/[0.03]">
          <td class="px-5 py-3">
            <div class="flex items-center gap-3">
              <div class="w-9 h-9 rounded-full ${colors[u.id % colors.length]} flex items-center justify-center text-white text-xs font-bold">${esc(initials)}</div>
              <div>
                <p class="text-white font-semibold text-sm">${esc(u.name) || '<span class="text-slate-500 italic font-normal">No name</span>'}</p>
                <p class="text-slate-500 text-xs">#${u.id} · ${esc(u.email || "")}</p>
              </div>
            </div>
          </td>
          <td class="px-5 py-3 text-sm">${phone}</td>
          <td class="px-5 py-3">${providerBadge(u.provider)}</td>
          <td class="px-5 py-3">${u.has_device
            ? '<span class="text-emerald-400 text-xs font-semibold">📱 push ok</span>'
            : '<span class="text-slate-600 text-xs">no device</span>'}</td>
          <td class="px-5 py-3">${paused
            ? '<span class="text-orange-400 text-xs font-semibold">⏸ Paused</span>'
            : '<span class="text-emerald-400 text-xs font-semibold">● Active</span>'}</td>
          <td class="px-5 py-3 text-slate-500 text-xs">${fmtDate(u.created_at)}</td>
          <td class="px-5 py-3 text-right whitespace-nowrap">
            <form method="POST" action="/admin-panel/action" class="inline-flex gap-2">
              <input type="hidden" name="id" value="${u.id}">
              <input type="hidden" name="key" value="${esc(key)}">
              <button name="action" value="${paused ? "resume" : "pause"}"
                class="${paused ? "text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/10" : "text-orange-400 border-orange-500/30 hover:bg-orange-500/10"} text-xs font-semibold border px-3 py-1.5 rounded-lg">${paused ? "▶ Resume" : "⏸ Pause"}</button>
              <button name="action" value="delete"
                onclick="return confirm('Permanently delete user #${u.id}? This cannot be undone.')"
                class="text-red-500 border border-red-500/30 hover:bg-red-500/10 text-xs font-semibold px-3 py-1.5 rounded-lg">🗑</button>
            </form>
          </td>
        </tr>`;
    }).join("");

    const feedHtml = activity.length
      ? activity.map((a) => `
          <div class="flex items-start gap-3 px-5 py-3 border-b border-white/5">
            <span class="w-1.5 h-1.5 mt-2 rounded-full bg-cyan-400 flex-shrink-0"></span>
            <div class="min-w-0">
              <p class="text-sm text-slate-200 truncate">
                <span class="text-cyan-300 font-semibold">${esc(a.name || "someone")}</span>
                <span class="text-slate-500">·</span> ${esc(a.action)}
              </p>
              <p class="text-xs text-slate-500 truncate">${esc(a.detail || "")} <span class="text-slate-600">— ${timeAgo(a.created_at)}</span></p>
            </div>
          </div>`).join("")
      : `<p class="px-5 py-8 text-slate-500 text-sm text-center">No activity recorded yet.</p>`;

    const err = req.query.error
      ? `<div class="mb-6 px-5 py-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-sm font-semibold">⚠ ${esc(req.query.error)}</div>`
      : "";

    res.send(page("Command Center", `
      <header class="flex items-center justify-between mb-8 flex-wrap gap-4">
        <div>
          <p class="text-slate-500 text-xs font-semibold uppercase tracking-widest mb-1">Hari · Admin</p>
          <h1 class="text-3xl font-bold neon">Command Center</h1>
          <p class="text-xs mt-2">
            <a class="text-slate-500 hover:text-cyan-300 underline" href="/legal/privacy" target="_blank">Privacy Policy</a>
            <span class="text-slate-700 mx-1">·</span>
            <a class="text-slate-500 hover:text-cyan-300 underline" href="/legal/terms" target="_blank">Terms</a>
          </p>
        </div>
        <div class="flex items-center gap-4">
          <div class="glass px-4 py-2 rounded-full flex items-center gap-2">
            <span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
            <span class="text-emerald-400 text-xs font-bold uppercase tracking-wider">Live</span>
          </div>
          <div class="glass px-4 py-2 rounded-2xl">
            <p class="text-slate-500 text-[10px] uppercase font-semibold tracking-wider mb-1">Signups · last 14 days</p>
            ${spark}
          </div>
        </div>
      </header>
      ${err}
      <p class="text-slate-500 text-[11px] font-bold uppercase tracking-widest mb-2">Engagement</p>
      <div class="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
        ${kpi("Active today", dau, "#00F0FF")}
        ${kpi("Active / 7d", wau, "#35C48D")}
        ${kpi("Actions / 24h", actions24, "#B265FF")}
        ${kpi("Users", users.length, "#f59e0b")}
        ${kpi("New / 7d", newWeek, "#ec4899")}
      </div>
      <p class="text-slate-500 text-[11px] font-bold uppercase tracking-widest mb-2">Feature adoption</p>
      <div class="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3 mb-8">
        ${kpi("Verified phones", verified, "#35C48D")}
        ${kpi("Documents", docs, "#f59e0b")}
        ${kpi("Reminders", reminders, "#ec4899")}
        ${kpi("Promises", commitsOpen, "#f97316")}
        ${kpi("Client files", clients, "#22d3ee")}
        ${kpi("Msgs relayed", agentMsgs, "#a3e635")}
        ${kpi("Finance items", financeItems, "#B265FF")}
      </div>
      <div class="grid lg:grid-cols-3 gap-6">
        <div class="glass rounded-2xl overflow-hidden lg:col-span-2">
          <div class="flex items-center justify-between px-6 py-4 border-b border-white/5">
            <div>
              <h2 class="text-white font-bold">Users</h2>
              <p class="text-slate-500 text-xs mt-0.5">${users.length} accounts · ${memories} memories · ${convMsgs} chat messages</p>
            </div>
            <input id="q" type="text" placeholder="Search…" onkeyup="
              const v=this.value.toLowerCase();
              document.querySelectorAll('#ut tbody tr').forEach(r=>r.style.display=r.textContent.toLowerCase().includes(v)?'':'none');"
              class="bg-white/5 border border-white/10 text-slate-200 placeholder-slate-600 text-sm rounded-xl px-4 py-2 w-48">
          </div>
          <div class="overflow-x-auto">
            <table id="ut" class="w-full text-sm">
              <thead><tr class="text-[10px] uppercase tracking-widest text-slate-500 border-b border-white/5">
                <th class="px-5 py-3 text-left font-semibold">User</th>
                <th class="px-5 py-3 text-left font-semibold">Phone</th>
                <th class="px-5 py-3 text-left font-semibold">Provider</th>
                <th class="px-5 py-3 text-left font-semibold">Device</th>
                <th class="px-5 py-3 text-left font-semibold">Status</th>
                <th class="px-5 py-3 text-left font-semibold">Joined</th>
                <th class="px-5 py-3 text-right font-semibold">Actions</th>
              </tr></thead>
              <tbody>${rowsHtml || '<tr><td colspan="7" class="px-5 py-16 text-center text-slate-500">No users yet.</td></tr>'}</tbody>
            </table>
          </div>
        </div>
        <div class="glass rounded-2xl overflow-hidden">
          <div class="px-6 py-4 border-b border-white/5">
            <h2 class="text-white font-bold">Live activity</h2>
            <p class="text-slate-500 text-xs mt-0.5">Audit trail, newest first</p>
          </div>
          <div class="max-h-[560px] overflow-y-auto">${feedHtml}</div>
        </div>
      </div>`));
  } catch (e) {
    console.error("admin panel error:", e.message);
    res.status(500).send(page("Error",
      `<p class="text-red-400 font-semibold">The panel hit a database error.</p>
       <p class="text-slate-500 text-sm mt-2"><code>${esc(e.message)}</code></p>`));
  }
});

module.exports = router;
