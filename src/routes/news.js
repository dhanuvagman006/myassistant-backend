/**
 * NEWS FEED (behind appAuth) — the stories for Hub → News.
 *
 *   GET /news/feed?topic=&count=&sort=   → { ok, topic, items: [story] }
 *
 * The same story shape the voice deck gets from show_news, from the same
 * cached lookup, so a topic one user opened this morning costs the next
 * user nothing. Without a news key it falls back to the free RSS
 * headlines, in the same shape with no pictures (tools/news.js feed).
 *
 * What was opened here also becomes the deck "read me the second one"
 * refers to (read_news_story): it is what the user is looking at.
 */
const router = require("express").Router();
const rateLimit = require("express-rate-limit");
const news = require("../tools/news");

// Every new topic is a paid lookup, and `topic` is free text: one account
// flicking through arbitrary topics must not be able to spend the quota.
const perUser = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  keyGenerator: (req) => String(req.user?.sub || req.ip),
});

router.get("/feed", perUser, async (req, res) => {
  const topic = String(req.query.topic || "")
    .replace(/[^\p{L}\p{N}\s&'-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  const count = Math.max(1, Math.min(Number.parseInt(req.query.count, 10) || 12, news.MAX_STORIES));
  const sort = req.query.sort === "recent" ? "recent" : "relevance";
  try {
    const out = await news.feed({ topic, count, sort });
    news.rememberShown(req.user && req.user.sub, out.topic, out.items);
    res.json({ ok: true, topic: out.topic, items: out.items });
  } catch (e) {
    console.warn(`news feed failed: ${String(e.message).slice(0, 160)}`);
    res.status(502).json({ ok: false, error: "news unavailable" });
  }
});

module.exports = router;
