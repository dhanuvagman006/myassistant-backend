/**
 * THE SHOPPING LIST — one list per user for anything they want to buy.
 * Wiring (server.js / builtins.js / privacy.js) needs only what is here:
 *
 *   app.use("/shopping", appAuth, shopping.limiter, shopping.router);
 *   shopping.registerShoppingTools(registry);          // in registerBuiltins()
 *   ...shopping.USER_TABLES                            // privacy export / erase
 *
 * Tables are created lazily on first use; migrate() may also be awaited at
 * boot.
 */
const rateLimit = require("express-rate-limit");
const router = require("./routes");
const { registerShoppingTools, APP_BUILD } = require("./tools");
const { migrate } = require("./store");

// Its own per-user bucket, like posters and shortcuts (server.js): a list
// screen ticking items off must never starve the voice turns.
const limiter = rateLimit({
  windowMs: 60_000,
  max: Number(process.env.SHOPPING_RATE_PER_MIN) || 120,
  standardHeaders: true,
  keyGenerator: (req) => String(req.user?.sub || req.ip),
});

const USER_TABLES = [["shopping_items", "user_id"]];

module.exports = { router, limiter, registerShoppingTools, migrate, USER_TABLES, APP_BUILD };
