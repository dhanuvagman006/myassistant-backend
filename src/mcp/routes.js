/**
 * MCP MANAGEMENT API (§12).
 *
 * Every handler resolves the row by (id AND user_id), so an id belonging to
 * another user is indistinguishable from one that does not exist — no
 * endpoint can leak the existence of another tenant's server (§6).
 *
 * No response is ever built by hand: everything goes through
 * schema.toClient(), which structurally cannot emit secrets (§13).
 */
const router = require("express").Router();
const { query, one, run } = require("../db");
const schema = require("./schema");
const manager = require("./manager");

const now = () => Date.now();

function uid(req) {
  const id = Number(req.user?.sub);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function requireUser(req, res) {
  const id = uid(req);
  if (!id) {
    res.status(401).json({ error: "sign in to manage MCP servers" });
    return null;
  }
  return id;
}

/** Loads a server owned by this user, or null. */
async function owned(userId, id) {
  return one(`SELECT * FROM mcp_servers WHERE user_id=$1 AND id=$2`, [
    userId,
    Number(id),
  ]);
}

/**
 * CURATED CATALOG — one-tap connections for non-technical users. A blank
 * "add server URL" form is developer furniture; these cards are the
 * product. Free/no-signup entries first; keyed ones say exactly which
 * single token to paste and where to get it. Server-side so new entries
 * reach every installed app without an update.
 */
const CATALOG = [
  {
    id: "fetch",
    name: "Web page reader",
    description:
      "Lets your assistant open and read any link you mention — articles, " +
      "reports, product pages — and answer from what's on them.",
    category: "Knowledge",
    transport: "http",
    config: { url: "https://remote.mcpservers.org/fetch/mcp" },
    auth: { type: "none" },
  },
  {
    id: "zerodha-kite",
    name: "Zerodha trading",
    description:
      "For Zerodha account holders: live portfolio, positions and order " +
      "placement by voice. Free with your Zerodha account — you log in " +
      "once in the conversation when first used.",
    category: "Finance",
    transport: "sse",
    config: { url: "https://mcp.kite.trade/sse" },
    auth: { type: "none" },
  },
  {
    id: "notion",
    name: "Notion workspace",
    description:
      "Read and update your Notion pages and databases — notes, trackers, " +
      "client records. Needs one integration token from notion.so/my-integrations.",
    category: "Productivity",
    transport: "http",
    config: { url: "https://mcp.notion.com/mcp" },
    auth: {
      type: "bearer",
      label: "Notion integration token",
      hint: "Create a free internal integration at notion.so/my-integrations and paste its secret.",
    },
  },
  {
    id: "github",
    name: "GitHub",
    description:
      "Repositories, issues and pull requests by voice. Needs a personal " +
      "access token from github.com/settings/tokens.",
    category: "Developer",
    transport: "http",
    config: { url: "https://api.githubcopilot.com/mcp/" },
    auth: {
      type: "bearer",
      label: "GitHub personal access token",
      hint: "Create a fine-grained token at github.com/settings/tokens and paste it.",
    },
  },
];

// GET /mcp/catalog — the curated one-tap list (no user data involved).
router.get("/catalog", (_req, res) => {
  res.json({ catalog: CATALOG });
});

// POST /mcp/catalog/:id/connect { token? } — add a catalog entry as this
// user's server, with the pasted token (if any) stored encrypted as an
// Authorization header secret. Reuses the exact add-server path.
router.post("/catalog/:id/connect", async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const entry = CATALOG.find((c) => c.id === req.params.id);
  if (!entry) return res.status(404).json({ error: "unknown catalog entry" });
  const token = String(req.body?.token || "").trim();
  if (entry.auth.type === "bearer" && !token) {
    return res.status(400).json({ error: `${entry.auth.label} required` });
  }
  const secrets =
    entry.auth.type === "bearer"
      ? { headers: { Authorization: `Bearer ${token}` } }
      : null;
  try {
    const row = await one(
      `INSERT INTO mcp_servers (user_id, name, transport, config, secrets_enc, enabled, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,1,$6,$6)
       ON CONFLICT (user_id, lower(name)) DO UPDATE
         SET transport=$3, config=$4, secrets_enc=$5, enabled=1, updated_at=$6
       RETURNING *`,
      [user, entry.name, entry.transport, JSON.stringify(entry.config),
       secrets ? schema.encryptSecrets(secrets) : null, now()]
    );
    // Connect right away so the card shows truth, not hope — same call
    // shape as the manual connect route: (user, ROW, decrypted secrets),
    // never-throwing, and the outcome persisted on the row.
    const out = await manager.connect(user, row, secrets || {});
    const saved = await one(
      `UPDATE mcp_servers SET status=$3, last_error=$4, tools_cache=$5,
         last_connected_at=CASE WHEN $3='connected' THEN $6 ELSE last_connected_at END,
         updated_at=$6
       WHERE user_id=$1 AND id=$2 RETURNING *`,
      [user, row.id, out.status, out.error || "", JSON.stringify(out.tools || []), now()]
    );
    res.json({
      server: schema.toClient(saved || row, manager.statusOf(user, row.id)),
      status: { ok: out.status === "connected", error: out.error || null, tools: (out.tools || []).length },
    });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e).slice(0, 200) });
  }
});

// GET /mcp/servers
router.get("/servers", async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const rows = await query(
    `SELECT * FROM mcp_servers WHERE user_id=$1 ORDER BY id DESC`,
    [user]
  );
  res.json({
    servers: rows.map((r) => schema.toClient(r, manager.statusOf(user, r.id))),
  });
});

// POST /mcp/servers
router.post("/servers", async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const name = String(req.body?.name || "").trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: "name required" });

  const transport = String(req.body?.transport || "http").toLowerCase();
  if (!["http", "sse", "stdio"].includes(transport)) {
    return res.status(400).json({ error: "transport must be http, sse or stdio" });
  }
  const { config, secrets } = schema.splitSecrets(req.body);
  if (transport === "stdio" && !config.command) {
    return res.status(400).json({ error: "stdio needs config.command" });
  }
  if (transport !== "stdio" && !config.url) {
    return res.status(400).json({ error: `${transport} needs config.url` });
  }

  try {
    const row = await one(
      `INSERT INTO mcp_servers
         (user_id,name,description,transport,config,secrets_enc,enabled,status,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,1,'disconnected',$7,$7) RETURNING *`,
      [
        user,
        name,
        String(req.body?.description || "").slice(0, 300),
        transport,
        JSON.stringify(config),
        schema.encryptSecrets(secrets),
        now(),
      ]
    );
    res.status(201).json({ server: schema.toClient(row) });
  } catch (e) {
    if (/idx_mcp_user_name|unique/i.test(e.message)) {
      return res.status(409).json({ error: "a server with that name already exists" });
    }
    res.status(500).json({ error: "could not save the server" });
  }
});

// GET /mcp/servers/:id
router.get("/servers/:id", async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const row = await owned(user, req.params.id);
  if (!row) return res.status(404).json({ error: "not found" });
  res.json({ server: schema.toClient(row, manager.statusOf(user, row.id)) });
});

// PUT /mcp/servers/:id
router.put("/servers/:id", async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const row = await owned(user, req.params.id);
  if (!row) return res.status(404).json({ error: "not found" });

  const { config, secrets } = schema.splitSecrets(req.body);
  const merged = { ...(row.config || {}), ...config };
  // Only replace stored secrets when new ones were supplied — a plain
  // rename must not wipe the credentials.
  const secretsEnc = Object.keys(secrets).length
    ? schema.encryptSecrets(secrets)
    : row.secrets_enc;

  const updated = await one(
    `UPDATE mcp_servers SET
       name=COALESCE(NULLIF($3,''),name),
       description=COALESCE(NULLIF($4,''),description),
       transport=COALESCE(NULLIF($5,''),transport),
       config=$6, secrets_enc=$7, updated_at=$8
     WHERE user_id=$1 AND id=$2 RETURNING *`,
    [
      user,
      row.id,
      String(req.body?.name || "").trim(),
      String(req.body?.description || ""),
      String(req.body?.transport || ""),
      JSON.stringify(merged),
      secretsEnc,
      now(),
    ]
  );
  await manager.disconnect(user, row.id); // config changed → stale session
  res.json({ server: schema.toClient(updated) });
});

// DELETE /mcp/servers/:id
router.delete("/servers/:id", async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const row = await owned(user, req.params.id);
  if (!row) return res.status(404).json({ error: "not found" });
  await manager.disconnect(user, row.id);
  await run(`DELETE FROM mcp_servers WHERE user_id=$1 AND id=$2`, [user, row.id]);
  res.json({ ok: true });
});

// POST /mcp/servers/:id/connect   (and /reconnect — same operation)
for (const path of ["/servers/:id/connect", "/servers/:id/reconnect"]) {
  router.post(path, async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    const row = await owned(user, req.params.id);
    if (!row) return res.status(404).json({ error: "not found" });
    if (row.enabled !== 1) {
      return res.status(400).json({ error: "server is disabled" });
    }

    const secrets = schema.decryptSecrets(row.secrets_enc);
    if (row.secrets_enc && secrets === null) {
      await markStatus(user, row.id, "error", "stored credentials could not be read — re-enter them");
      return res.status(400).json({ error: "stored credentials could not be read — re-enter them" });
    }

    await markStatus(user, row.id, "connecting", "");
    const out = await manager.connect(user, row, secrets || {});
    const saved = await one(
      `UPDATE mcp_servers SET status=$3, last_error=$4, tools_cache=$5,
         last_connected_at=CASE WHEN $3='connected' THEN $6 ELSE last_connected_at END,
         updated_at=$6
       WHERE user_id=$1 AND id=$2 RETURNING *`,
      [user, row.id, out.status, out.error || "", JSON.stringify(out.tools || []), now()]
    );
    // A failed connection is a 200 with an error status, not a 500: the
    // settings screen needs to render the badge, not a crash.
    res.json({ server: schema.toClient(saved, manager.statusOf(user, row.id)) });
  });
}

// POST /mcp/servers/:id/disconnect
router.post("/servers/:id/disconnect", async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const row = await owned(user, req.params.id);
  if (!row) return res.status(404).json({ error: "not found" });
  await manager.disconnect(user, row.id);
  const saved = await one(
    `UPDATE mcp_servers SET status='disconnected', tools_cache='[]', updated_at=$3
      WHERE user_id=$1 AND id=$2 RETURNING *`,
    [user, row.id, now()]
  );
  res.json({ server: schema.toClient(saved) });
});

// PUT /mcp/servers/:id/enabled
router.put("/servers/:id/enabled", async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const row = await owned(user, req.params.id);
  if (!row) return res.status(404).json({ error: "not found" });
  const enabled = req.body?.enabled === true || req.body?.enabled === "true";
  if (!enabled) await manager.disconnect(user, row.id);
  const saved = await one(
    `UPDATE mcp_servers SET enabled=$3, status=$4, updated_at=$5
      WHERE user_id=$1 AND id=$2 RETURNING *`,
    [user, row.id, enabled ? 1 : 0, enabled ? "disconnected" : "disabled", now()]
  );
  res.json({ server: schema.toClient(saved) });
});

// GET /mcp/servers/:id/tools
router.get("/servers/:id/tools", async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const row = await owned(user, req.params.id);
  if (!row) return res.status(404).json({ error: "not found" });
  const live = manager.statusOf(user, row.id);
  res.json({
    status: live?.status || row.status,
    tools: schema.toClient(row, live).tools,
  });
});

async function markStatus(user, id, status, error) {
  await run(
    `UPDATE mcp_servers SET status=$3, last_error=$4, updated_at=$5
      WHERE user_id=$1 AND id=$2`,
    [user, id, status, error, now()]
  );
}

/**
 * Reconnects every enabled server for a user (called when a live agent
 * session starts, so tools are ready before the first request).
 */
async function connectAllForUser(userId) {
  const rows = await query(
    `SELECT * FROM mcp_servers WHERE user_id=$1 AND enabled=1`,
    [userId]
  );
  const out = [];
  for (const row of rows) {
    const secrets = schema.decryptSecrets(row.secrets_enc) || {};
    const r = await manager.connect(userId, row, secrets);
    await run(
      `UPDATE mcp_servers SET status=$3, last_error=$4, tools_cache=$5, updated_at=$6
        WHERE user_id=$1 AND id=$2`,
      [userId, row.id, r.status, r.error || "", JSON.stringify(r.tools || []), now()]
    );
    out.push({ id: row.id, name: row.name, ...r });
  }
  return out;
}

module.exports = router;
module.exports.connectAllForUser = connectAllForUser;
