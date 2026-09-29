/**
 * ASSISTANT FUNCTIONS — Android AppFunctions (Android 16+): Gemini and other
 * system agents act on the user's list, reminders, Today's 3 and habits
 * without the app open. Wiring (server.js):
 *
 *   app.use("/appfunctions/token", appAuth, appfunctions.limiter, appfunctions.tokenRouter);
 *   app.use("/appfunctions", appFnAuth, appfunctions.limiter, appfunctions.router);
 *
 * Its own per-user bucket (60 a minute): an agent looping on a function
 * must never starve the user's own conversation.
 */
const rateLimit = require("express-rate-limit");

const RATE_PER_MIN = Number(process.env.APPFUNCTIONS_RATE_PER_MIN) || 60;

function makeLimiter(max = RATE_PER_MIN) {
  return rateLimit({
    windowMs: 60_000,
    max,
    standardHeaders: true,
    keyGenerator: (req) => String(req.user?.sub || req.ip),
    message: { error: "too_many_requests", message: "Too many requests — try again in a minute." },
  });
}

module.exports = {
  router: require("./routes"),
  tokenRouter: require("./token").router,
  limiter: makeLimiter(),
  makeLimiter,
  RATE_PER_MIN,
};
