/**
 * KITCHEN — pantry, saved recipes, the week plan and the cooking
 * preferences; the app does the cooking (Firebase AI Logic). Ingredients
 * go onto the general shopping list (src/shopping). Wiring:
 *
 *   app.use("/kitchen", appAuth, kitchen.limiter, kitchen.router);
 *   kitchen.registerKitchenTools(registry);            // in registerBuiltins()
 *   ...kitchen.USER_TABLES                             // privacy export / erase
 *
 * Tables are created lazily on first use; migrate() may also be awaited at
 * boot.
 */
const rateLimit = require("express-rate-limit");
const router = require("./routes");
const { registerKitchenTools } = require("./tools");
const { migrate } = require("./store");

const limiter = rateLimit({
  windowMs: 60_000,
  max: Number(process.env.KITCHEN_RATE_PER_MIN) || 120,
  standardHeaders: true,
  keyGenerator: (req) => String(req.user?.sub || req.ip),
});

const USER_TABLES = [
  ["kitchen_pantry", "user_id"],
  ["kitchen_recipes", "user_id"],
  ["kitchen_plans", "user_id"],
];

module.exports = { router, limiter, registerKitchenTools, migrate, USER_TABLES };
