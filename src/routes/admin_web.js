const router = require("express").Router();
const db = require("../db");
const express = require("express");

// Allow form bodies on this router
router.use(express.json());
router.use(express.urlencoded({ extended: false }));

// Simple secret-based guard — set ADMIN_SECRET in your .env.
// If not set, the panel is open (dev convenience only).
function adminGuard(req, res, next) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return next(); // not configured → open (dev mode)
  const provided =
    req.cookies?.adminSecret ||
    req.headers["x-admin-secret"] ||
    req.query.secret;
  if (provided === secret) return next();
  return res
    .status(401)
    .send(`<!DOCTYPE html><html><body style="font-family:sans-serif;background:#06080E;color:#E2E8F0;padding:40px">
      <h2 style="color:#FF2A5F">⛔ Unauthorized</h2>
      <p>Pass your <code>ADMIN_SECRET</code> as a <code>?secret=</code> query parameter.</p>
    </body></html>`);
}
router.use(adminGuard);

// ─── API ACTIONS (form POST-based, no inline JS needed) ───────────────────

router.post("/action", async (req, res) => {
  const { action, id, status, name, phone } = req.body;
  try {
    if (action === "delete") {
      await db.query("DELETE FROM users WHERE id = $1", [id]);
    } else if (action === "pause") {
      await db.query("UPDATE users SET status = 'paused' WHERE id = $1", [id]);
    } else if (action === "resume") {
      await db.query("UPDATE users SET status = 'active' WHERE id = $1", [id]);
    } else if (action === "add") {
      if (!phone) return res.status(400).send("Phone required");
      await db.query(
        "INSERT INTO users (name, phone, provider, created_at, status) VALUES ($1, $2, 'phone', $3, 'active')",
        [name || null, phone.trim(), Date.now()]
      );
    }
    res.redirect("/admin-panel");
  } catch (e) {
    if (e.code === "23505") {
      res.redirect("/admin-panel?error=Phone+number+already+exists");
    } else {
      res.redirect("/admin-panel?error=" + encodeURIComponent(e.message));
    }
  }
});

// ─── MAIN DASHBOARD ───────────────────────────────────────────────────────

router.get("/", async (req, res) => {
  try {
    const usersRows = await db.query(
      "SELECT id, name, email, phone, provider, created_at, status FROM users ORDER BY created_at DESC LIMIT 100"
    );
    const totalCountRow = await db.query("SELECT COUNT(*) as count FROM users");
    const activeCountRow = await db.query(
      // IS DISTINCT FROM handles NULLs correctly (NULL status → treated as active)
      "SELECT COUNT(*) as count FROM users WHERE status IS DISTINCT FROM 'paused'"
    );
    const pausedCountRow = await db.query("SELECT COUNT(*) as count FROM users WHERE status = 'paused'");

    const totalUsers = parseInt(totalCountRow[0].count, 10);
    const activeUsers = parseInt(activeCountRow[0].count, 10);
    const pausedUsers = parseInt(pausedCountRow[0].count, 10);
    const errorMsg = req.query.error || "";

    let usersHtml = "";
    if (usersRows.length === 0) {
      usersHtml = `
        <div class="flex flex-col items-center justify-center py-20 text-center">
          <div class="w-16 h-16 rounded-full bg-[#00F0FF]/10 flex items-center justify-center mb-4">
            <svg class="w-8 h-8 text-[#00F0FF]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
          </div>
          <p class="text-slate-400 text-sm">No users registered yet.</p>
          <p class="text-slate-600 text-xs mt-1">Use the form below to add the first user.</p>
        </div>`;
    } else {
      usersRows.forEach((u, i) => {
        const date = new Date(parseInt(u.created_at)).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
        const contact = u.phone || u.email || "—";
        const isPaused = u.status === "paused";
        const statusDot = isPaused
          ? `<span class="flex items-center gap-1.5"><span class="w-2 h-2 rounded-full bg-orange-500 inline-block"></span><span class="text-orange-400 text-xs font-semibold">Paused</span></span>`
          : `<span class="flex items-center gap-1.5"><span class="w-2 h-2 rounded-full bg-emerald-400 inline-block animate-pulse"></span><span class="text-emerald-400 text-xs font-semibold">Active</span></span>`;

        const providerColor = {
          google: "bg-blue-500/20 text-blue-300 border-blue-500/30",
          apple: "bg-slate-500/20 text-slate-300 border-slate-500/30",
          email: "bg-violet-500/20 text-violet-300 border-violet-500/30",
          phone: "bg-cyan-500/20 text-cyan-300 border-cyan-500/30",
        }[u.provider] || "bg-white/10 text-white/60 border-white/10";

        const initials = (u.name || "?").split(" ").map(n => n[0]).join("").toUpperCase().slice(0, 2);
        const avatarColors = ["bg-violet-600", "bg-cyan-600", "bg-pink-600", "bg-emerald-600", "bg-amber-600"];
        const avatarColor = avatarColors[u.id % avatarColors.length];

        usersHtml += `
          <tr class="border-b border-white/5 hover:bg-white/[0.03] transition-colors group">
            <td class="px-5 py-4">
              <div class="flex items-center gap-3">
                <div class="w-9 h-9 rounded-full ${avatarColor} flex items-center justify-center text-white text-xs font-bold flex-shrink-0">${initials}</div>
                <div>
                  <p class="text-white font-semibold text-sm">${u.name || '<span class="text-slate-500 italic font-normal">No name</span>'}</p>
                  <p class="text-slate-500 text-xs">#${u.id}</p>
                </div>
              </div>
            </td>
            <td class="px-5 py-4 text-slate-300 text-sm font-mono">${contact}</td>
            <td class="px-5 py-4">
              <span class="px-2 py-0.5 text-[10px] uppercase font-bold rounded-full border ${providerColor}">${u.provider}</span>
            </td>
            <td class="px-5 py-4">${statusDot}</td>
            <td class="px-5 py-4 text-slate-500 text-xs">${date}</td>
            <td class="px-5 py-4 text-right">
              <form method="POST" action="/admin-panel/action" class="inline-flex items-center gap-2">
                <input type="hidden" name="id" value="${u.id}">
                <button type="submit" name="action" value="${isPaused ? "resume" : "pause"}"
                  class="${isPaused ? "text-emerald-400 hover:text-emerald-300 border-emerald-500/30 hover:bg-emerald-500/10" : "text-orange-400 hover:text-orange-300 border-orange-500/30 hover:bg-orange-500/10"} text-xs font-semibold border px-3 py-1.5 rounded-lg transition-all">
                  ${isPaused ? "▶ Resume" : "⏸ Pause"}
                </button>
                <button type="submit" name="action" value="delete" 
                  onclick="return confirm('Permanently delete this user? This cannot be undone.')"
                  class="text-red-500 hover:text-red-400 border border-red-500/30 hover:bg-red-500/10 text-xs font-semibold px-3 py-1.5 rounded-lg transition-all">
                  🗑 Delete
                </button>
              </form>
            </td>
          </tr>`;
      });
    }

    res.setHeader("Content-Security-Policy", 
      "default-src 'self'; script-src 'self' https://cdn.tailwindcss.com 'unsafe-inline'; style-src 'self' https: 'unsafe-inline'; font-src 'self' https: data:; img-src 'self' data:;"
    );

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Command Center — MYASSISTANT</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    * { font-family: 'Inter', sans-serif; }
    body { background: #060810; }
    .glass { background: rgba(255,255,255,0.03); backdrop-filter: blur(20px); border: 1px solid rgba(255,255,255,0.07); }
    .neon { color: #00F0FF; text-shadow: 0 0 20px rgba(0,240,255,0.4); }
    .neon-border { border-left: 3px solid #00F0FF; box-shadow: -4px 0 20px rgba(0,240,255,0.1); }
    .kpi-card { transition: transform 0.2s, box-shadow 0.2s; }
    .kpi-card:hover { transform: translateY(-2px); box-shadow: 0 8px 40px rgba(0,240,255,0.08); }
    .btn-add { background: linear-gradient(135deg, #00F0FF, #7B5FFF); }
    .btn-add:hover { opacity: 0.9; box-shadow: 0 4px 20px rgba(0,240,255,0.3); }
    ::-webkit-scrollbar { width: 4px; height: 4px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: rgba(0,240,255,0.2); border-radius: 4px; }
    input:focus { outline: none; border-color: rgba(0,240,255,0.5) !important; box-shadow: 0 0 0 3px rgba(0,240,255,0.1); }
    .modal-bg { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.7); backdrop-filter: blur(4px); z-index: 50; align-items: center; justify-content: center; }
    .modal-bg.show { display: flex; }
  </style>
  <script>
    function showAddModal() { document.getElementById('addModal').classList.add('show'); }
    function hideAddModal() { document.getElementById('addModal').classList.remove('show'); }
    function filterTable() {
      const q = document.getElementById('searchInput').value.toLowerCase();
      document.querySelectorAll('#userTable tbody tr').forEach(row => {
        row.style.display = row.textContent.toLowerCase().includes(q) ? '' : 'none';
      });
    }
  </script>
</head>
<body class="min-h-screen text-slate-200">

  <!-- Ambient background blobs -->
  <div style="position:fixed;inset:0;pointer-events:none;z-index:0;">
    <div style="position:absolute;top:-200px;left:-100px;width:600px;height:600px;background:radial-gradient(circle,rgba(0,240,255,0.07) 0%,transparent 70%);border-radius:50%;"></div>
    <div style="position:absolute;bottom:-200px;right:-100px;width:700px;height:700px;background:radial-gradient(circle,rgba(123,95,255,0.06) 0%,transparent 70%);border-radius:50%;"></div>
  </div>

  <div class="relative z-10 max-w-7xl mx-auto px-6 py-10">

    <!-- Header -->
    <header class="flex items-center justify-between mb-10">
      <div>
        <p class="text-slate-500 text-xs font-semibold uppercase tracking-widest mb-1">Admin Panel</p>
        <h1 class="text-3xl font-bold neon">Command Center</h1>
        <p class="text-slate-500 text-sm mt-1">User Management &amp; Platform Analytics</p>
      </div>
      <div class="flex items-center gap-6">
        <div class="flex items-center gap-2 glass px-4 py-2 rounded-full">
          <span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse inline-block"></span>
          <span class="text-emerald-400 text-xs font-bold tracking-wider uppercase">System Online</span>
        </div>
        <button onclick="showAddModal()" class="btn-add text-black font-bold py-2.5 px-5 rounded-full text-sm transition-all flex items-center gap-2">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 4v16m8-8H4"/></svg>
          Add User
        </button>
      </div>
    </header>

    ${errorMsg ? `<div class="mb-6 px-5 py-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-sm font-semibold">⚠ ${errorMsg}</div>` : ""}

    <!-- KPI Cards -->
    <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
      <div class="glass kpi-card p-5 rounded-2xl neon-border">
        <p class="text-slate-500 text-[11px] font-semibold uppercase tracking-wider mb-2">Total Users</p>
        <p class="text-4xl font-bold text-white">${totalUsers}</p>
      </div>
      <div class="glass kpi-card p-5 rounded-2xl" style="border-left:3px solid #35C48D;box-shadow:-4px 0 20px rgba(53,196,141,0.1)">
        <p class="text-slate-500 text-[11px] font-semibold uppercase tracking-wider mb-2">Active</p>
        <p class="text-4xl font-bold text-white">${activeUsers}</p>
      </div>
      <div class="glass kpi-card p-5 rounded-2xl" style="border-left:3px solid #f97316;box-shadow:-4px 0 20px rgba(249,115,22,0.1)">
        <p class="text-slate-500 text-[11px] font-semibold uppercase tracking-wider mb-2">Paused</p>
        <p class="text-4xl font-bold text-white">${pausedUsers}</p>
      </div>
      <div class="glass kpi-card p-5 rounded-2xl" style="border-left:3px solid #B265FF;box-shadow:-4px 0 20px rgba(178,101,255,0.1)">
        <p class="text-slate-500 text-[11px] font-semibold uppercase tracking-wider mb-2">Providers</p>
        <p class="text-4xl font-bold text-white">${new Set(usersRows.map(u => u.provider)).size}</p>
      </div>
    </div>

    <!-- User Table -->
    <div class="glass rounded-2xl overflow-hidden">
      <!-- Table Header -->
      <div class="flex items-center justify-between px-6 py-4 border-b border-white/5">
        <div>
          <h2 class="text-white font-bold text-base">Registered Users</h2>
          <p class="text-slate-500 text-xs mt-0.5">Showing ${usersRows.length} of ${totalUsers} users</p>
        </div>
        <div class="relative">
          <input 
            id="searchInput" 
            type="text" 
            placeholder="Search users..." 
            onkeyup="filterTable()"
            class="bg-white/5 border border-white/10 text-slate-200 placeholder-slate-600 text-sm rounded-xl px-4 py-2.5 pl-9 w-64 transition-all"
          >
          <svg class="w-4 h-4 text-slate-500 absolute left-3 top-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>
        </div>
      </div>

      <!-- Table -->
      <div class="overflow-x-auto">
        <table id="userTable" class="w-full text-sm">
          <thead>
            <tr class="text-[10px] uppercase tracking-widest text-slate-500 border-b border-white/5">
              <th class="px-5 py-3 text-left font-semibold">User</th>
              <th class="px-5 py-3 text-left font-semibold">Contact</th>
              <th class="px-5 py-3 text-left font-semibold">Provider</th>
              <th class="px-5 py-3 text-left font-semibold">Status</th>
              <th class="px-5 py-3 text-left font-semibold">Joined</th>
              <th class="px-5 py-3 text-right font-semibold">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${usersHtml || `<tr><td colspan="6" class="px-5 py-20 text-center text-slate-500">No users found.</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>

  </div>

  <!-- Add User Modal -->
  <div id="addModal" class="modal-bg" onclick="if(event.target===this)hideAddModal()">
    <div class="glass rounded-2xl p-8 w-full max-w-md mx-4" style="border-color:rgba(0,240,255,0.2)">
      <div class="flex items-center justify-between mb-6">
        <h3 class="text-white font-bold text-lg">Add New User</h3>
        <button onclick="hideAddModal()" class="text-slate-500 hover:text-white text-xl leading-none">&times;</button>
      </div>
      <form method="POST" action="/admin-panel/action" class="space-y-4">
        <input type="hidden" name="action" value="add">
        <div>
          <label class="block text-slate-400 text-xs font-semibold uppercase tracking-wider mb-2">Full Name (optional)</label>
          <input type="text" name="name" placeholder="e.g. Ravi Kumar"
            class="w-full bg-white/5 border border-white/10 text-white placeholder-slate-600 text-sm rounded-xl px-4 py-3 transition-all">
        </div>
        <div>
          <label class="block text-slate-400 text-xs font-semibold uppercase tracking-wider mb-2">Phone Number <span class="text-red-400">*</span></label>
          <input type="tel" name="phone" placeholder="+91 98765 43210" required
            class="w-full bg-white/5 border border-white/10 text-white placeholder-slate-600 text-sm rounded-xl px-4 py-3 transition-all">
          <p class="text-slate-600 text-xs mt-1.5">One account per phone number is enforced.</p>
        </div>
        <div class="flex gap-3 pt-2">
          <button type="button" onclick="hideAddModal()" class="flex-1 text-slate-400 border border-white/10 hover:bg-white/5 font-semibold py-3 rounded-xl text-sm transition-all">Cancel</button>
          <button type="submit" class="flex-1 btn-add text-black font-bold py-3 rounded-xl text-sm transition-all">Create User</button>
        </div>
      </form>
    </div>
  </div>

</body>
</html>`);
  } catch (e) {
    res.status(500).send("Internal Server Error: " + e.message);
  }
});

module.exports = router;
