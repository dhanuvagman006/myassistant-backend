/**
 * KITCHEN BY VOICE (server side). The recipe card, cook mode, the fridge
 * photo and the week plan run in the app (Firebase AI Logic); what the
 * general assistant needs from the server here is the pantry:
 *
 *   pantry_update   "we're out of rice", "I have eggs and paneer now"
 *
 * The shopping list tools are src/shopping/tools.js — the list is for
 * anything, not only the kitchen.
 */
const store = require("./store");
const { listText } = require("../shopping/tools");
const N = require("../shopping/normalize");

function registerKitchenTools(registry) {
  registry.register({
    name: "pantry_update",
    risk: "medium",
    effects: ["write:record"],
    description:
      "Remember what the user HAS at home and what has RUN OUT in their kitchen, so recipes know what " +
      "to add to the shopping list — 'we're out of rice', 'no more curd', 'I have eggs and paneer', " +
      "'I have everything except curd and mint' (have the rest, out: curd, mint). Pass each thing as " +
      "they said it. It does NOT add anything to the shopping list: when something ran out, offer to " +
      "add it (shopping_list_add).",
    inputSchema: {
      type: "object",
      properties: {
        have: { type: "array", items: { type: "string" }, description: "Things they have now." },
        out: { type: "array", items: { type: "string" }, description: "Things that ran out / they don't have." },
      },
    },
    async execute(args, ctx) {
      const uid = Number(ctx && ctx.userId);
      if (!Number.isInteger(uid) || uid <= 0) return { ok: false, error: "not signed in" };
      const clean = (xs) => (Array.isArray(xs) ? xs : xs ? [xs] : [])
        .map((x) => String(x ?? "").trim()).filter(Boolean).map((x) => x.slice(0, 80));
      const have = clean(args.have);
      const out = clean(args.out);
      if (!have.length && !out.length) return { ok: false, needsArgs: ["have", "out"] };
      try {
        // "out" wins when the same thing is in both: better one extra buy.
        const outKeys = new Set(out.map((x) => N.nameKey(x)));
        const kept = have.filter((x) => !outKeys.has(N.nameKey(x)));
        const items = await store.setPantry(uid, { have: kept, out });
        const parts = [];
        if (kept.length) parts.push(`Noted you have ${listText(kept)}.`);
        if (out.length) parts.push(`Noted you're out of ${listText(out)}.`);
        return {
          ok: true,
          data: { have: kept, out, pantrySize: items.length },
          speak: parts.join(" "),
          note: out.length
            ? "Say it in one short sentence, then offer to add what ran out to the shopping list. Nothing was added yet."
            : "Say it in one short sentence.",
        };
      } catch (e) {
        if (e instanceof store.KitchenError) return { ok: false, error: e.message };
        throw e;
      }
    },
  });
}

module.exports = { registerKitchenTools };
