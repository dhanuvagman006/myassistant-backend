/**
 * BILLS BY EMAIL — the voice tool (spec §6.3): "what's my bills email",
 * "where do I forward my electricity bill", "did my forwarded bill arrive".
 *
 * It can show the address, say what recent emails became, and turn the
 * address on. It cannot switch it off or replace it — that is done on the
 * screen. `recent` carries outside senders' subjects, so it is marked
 * untrusted and the registry taints the session.
 */
const service = require("./service");
const address = require("./address");

const MAILIN_MIN_BUILD = 120;

const buildOf = (ctx) => Number(ctx && ctx.appBuild) || 0;
const tooOld = (ctx) => { const b = buildOf(ctx); return b > 0 && b < MAILIN_MIN_BUILD; };
const TOO_OLD = {
  ok: false,
  error: "app_too_old",
  data: { needsBuild: MAILIN_MIN_BUILD },
  note: "This phone's app is too old for Bills by email. Say an app update is needed, in one line.",
};
const OFF = {
  ok: false,
  error: "not_available",
  note: "Bills by email is not switched on for this service yet. Say so in one line; do not promise a date.",
};
const SCREEN = { type: "open_app_screen", screen: "bills_email" };

function registerMailinTools(registry) {
  registry.register({
    name: "bills_email",
    risk: "low",
    minAppBuild: MAILIN_MIN_BUILD,
    deviceAction: true,
    description:
      "The user's private email address for forwarding bills, tickets and renewals so " +
      "they are saved to documents with reminders — 'what's my bills email', 'where do I forward " +
      "my electricity bill', 'did my forwarded bill arrive'. action 'show' (default) gives the " +
      "address and opens its screen; 'recent' says what the last few emails became; 'turn_on' " +
      "creates it if they have none. It cannot switch off or replace the address — that is done " +
      "on the screen. Never read the address out character by character unless asked; say it is " +
      "on screen to copy.",
    inputSchema: {
      type: "object",
      properties: { action: { type: "string", enum: ["show", "recent", "turn_on"] } },
    },
    async execute(args, ctx = {}) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const uid = Number(ctx.userId);
      const action = ["show", "recent", "turn_on"].includes(args && args.action) ? args.action : "show";
      if (action !== "recent" && tooOld(ctx)) return TOO_OLD;
      if (!service.available()) return OFF;
      if (action === "recent") {
        const items = await service.recent(uid, 5);
        return {
          ok: true,
          untrusted: true, // subjects come from outside senders
          data: {
            messages: items.map((m) => ({ subject: m.subject, from: m.from, status: m.status, kind: m.kind,
              when: new Date(m.receivedAt).toISOString() })),
          },
        };
      }
      if (action === "turn_on") {
        if (ctx.background) return { ok: false, error: "the user turns this on themselves, on the screen" };
        const row = await address.turnOn(uid);
        return { ok: true, data: { address: address.toClient(row).address }, deviceAction: SCREEN,
          speak: "Your bills address is on your screen to copy." };
      }
      const row = await address.getForUser(uid);
      return {
        ok: true,
        data: { available: true, address: row ? address.toClient(row).address : null, status: row ? row.status : "not_set_up" },
        deviceAction: SCREEN,
        ...(row ? {} : { note: "They have no address yet. Offer to turn it on (action turn_on) or tap Turn on on the screen." }),
      };
    },
  });
}

module.exports = { registerMailinTools, MAILIN_MIN_BUILD };
