const router = require("express").Router();
const db = require("../db");

// Real numbers only. This endpoint used to 500 on a destructuring bug —
// and, worse, padded the user count by +1420 and served hand-written
// crashes and weekly curves "for wow factor". An admin dashboard that
// lies is worse than an empty one.
router.get("/", async (_req, res) => {
  try {
    const [users, active, docs, msgs, week] = await Promise.all([
      db.one(`SELECT COUNT(*)::int AS n FROM users`),
      db.one(`SELECT COUNT(*)::int AS n FROM users WHERE fcm_token IS NOT NULL AND fcm_token <> ''`),
      db.one(`SELECT COUNT(*)::int AS n, COALESCE(SUM(size),0)::bigint AS bytes FROM documents`),
      db.one(`SELECT COUNT(*)::int AS n FROM agent_messages`),
      db.query(
        `SELECT day, COUNT(DISTINCT user_id)::int AS users
           FROM app_usage_daily
          WHERE day >= to_char(now() - interval '6 days', 'YYYY-MM-DD')
          GROUP BY day ORDER BY day`
      ).catch(() => []),
    ]);
    res.json({
      overview: {
        totalUsers: users.n,
        activeUsers: active.n, // devices registered for push
        totalStorageGb: Number((Number(docs.bytes) / 1e9).toFixed(2)),
        totalDocuments: docs.n,
        totalMessages: msgs.n,
      },
      storage: {
        documents: Number((Number(docs.bytes) / 1e9).toFixed(2)),
        media: 0,
        logs: 0,
      },
      crashes: [], // no crash pipeline exists — an empty list is the truth
      usageActivity: week.map((r) => ({ day: r.day, users: r.users })),
    });
  } catch (e) {
    console.error("analytics failed:", e.message);
    res.status(500).json({ error: "analytics unavailable" });
  }
});

module.exports = router;
