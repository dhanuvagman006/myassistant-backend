/**
 * THE SHOPPING LIST BY VOICE — one list for anything the user wants to
 * buy, reachable from any conversation: "add this to my shopping list",
 * "I need to buy a phone charger", "what's on my list", "I bought the
 * milk", "send the list to Amma on WhatsApp", "order these".
 *
 *   shopping_list_add        add / merge lines (source "voice")
 *   shopping_list_show       read it; on build 124+ also opens the screen
 *   shopping_list_remove     take lines off
 *   shopping_list_check      tick (bought) or untick
 *   shopping_list_clear      clear the bought lines; "everything" asks first
 *                            by handing over to shopping_list_clear_all
 *   shopping_list_clear_all  HIGH risk: empties the list, after a yes
 *   share_shopping_list      WhatsApp with the list written; owner taps Send
 *   shop_from_list           HIGH risk: opens each line's search in the app
 *                            that fits it (shop_handoff); never pays
 *
 * Why two clear tools: the confirmation gate — and the live proxy's spoken
 * yes — key off a tool's risk, not its arguments. Clearing the bought
 * lines needs no yes; clearing everything does. So the second is its own
 * high-risk tool, the same split as run_shortcut -> continue_shortcut.
 */
const store = require("./store");
const N = require("./normalize");
const links = require("./links");
const { shareText, whatsappAction } = require("./share");
const { buildHandoff } = require("./handoff");

const APP_BUILD = 124; // the list screen, shop_handoff and the list notice

const buildOf = (ctx) => Number(ctx && ctx.appBuild) || 0;
const uidOf = (ctx) => {
  const id = Number(ctx && ctx.userId);
  return Number.isInteger(id) && id > 0 ? id : null;
};
/** Tells an open list screen to redraw; only builds that know it. */
const notice = (ctx) => (buildOf(ctx) >= APP_BUILD ? { type: "shopping_list_updated", notice: true } : undefined);
const NOT_SIGNED_IN = { ok: false, error: "not signed in" };

/** "a", "a and b", "a, b and c" */
function listText(xs) {
  const a = xs.map(String);
  if (a.length <= 1) return a.join("");
  return `${a.slice(0, -1).join(", ")} and ${a[a.length - 1]}`;
}
/** A name mid-sentence: "Onion" -> "onion", "iPhone case" stays. */
const spoken = (name) => (/^[A-Z][a-z0-9 ,'&-]*$/.test(name) ? name[0].toLowerCase() + name.slice(1) : name);
const brief = (i) => ({
  id: i.id, name: i.name, amount: i.amountText || "", details: i.details || "",
  category: i.category, store: i.store || "", checked: i.checked,
});
const said = (xs) => (Array.isArray(xs) ? xs : [xs]).map((x) => N.cleanText(typeof x === "object" && x ? x.name : x)).filter(Boolean);

// A stutter — the same add called twice in one turn — must not double
// the amounts. A new turn saying it again is a real "one more".
const recentAdds = new Map();
function repeatInTurn(uid, ctx, raw) {
  if (!ctx || !ctx.turnId || ctx.approved) return false;
  const key = `${uid}|${ctx.turnId}|${JSON.stringify(raw)}`;
  const now = Date.now();
  for (const [k, at] of recentAdds) if (now - at > 60_000) recentAdds.delete(k);
  if (recentAdds.has(key)) return true;
  recentAdds.set(key, now);
  return false;
}

/** Resolves spoken names against lines: { hits, missing, unclear }. */
function resolveSaid(items, names) {
  const hits = [];
  const missing = [];
  const unclear = [];
  for (const s of names) {
    const r = store.findBySaid(items, s);
    if (r.item) { if (!hits.includes(r.item)) hits.push(r.item); }
    else if (r.candidates) unclear.push({ said: s, candidates: r.candidates.map((c) => (c.details ? `${c.name} (${c.details})` : c.name)) });
    else missing.push(s);
  }
  return { hits, missing, unclear };
}

function unclearNote(unclear) {
  return unclear.map((u) => `"${u.said}" could be ${listText(u.candidates)}`).join("; ") +
    " — ask which one, in one short question.";
}

function registerShoppingTools(registry) {
  registry.register({
    name: "shopping_list_add",
    risk: "medium",
    effects: ["write:record"],
    description:
      "Add things to the user's ONE shopping list — for ANYTHING they want to buy: groceries, a dress, " +
      "shoes, a phone charger, medicines, a gift. Use for ANY 'add X to my shopping list', 'put it on the " +
      "list', 'I need to buy X', 'remind me to buy X', 'we're out of X', 'add the ingredients'. Resolve " +
      "'this', 'that' and 'it' from the conversation, the photo or the link they shared: name the actual " +
      "thing, put size / colour / brand / model in details, a product link in link, and the app or shop " +
      "they named in store. Ask one short question only if it is truly unclear what to add. Adding the " +
      "same thing again merges it (amounts add up). Not for ordering (shop_from_list) and not for a " +
      "reminder at a time (create_reminder).",
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          description: "Each thing to add, one entry per thing.",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "What it is, short: 'onion', 'kurti', 'phone charger', 'Dolo 650'." },
              quantity: { type: "number", description: "How many or how much, only if said." },
              unit: { type: "string", description: "g, kg, ml, l, pcs, packet, bunch, dozen, strip… only if said." },
              details: { type: "string", description: "Size, colour, brand, model or variant: 'M, blue floral, cotton', 'USB-C 25W', 'Amul'." },
              link: { type: "string", description: "The product's https link, if they shared one." },
              store: { type: "string", description: "The app or shop they want it from, if they said: 'Myntra', 'Blinkit'." },
              category: { type: "string", description: `Optional. One of: ${N.CATEGORY_IDS.join(", ")}.` },
              note: { type: "string", description: "Anything else worth keeping: 'for Amma's birthday'." },
            },
            required: ["name"],
          },
        },
      },
      required: ["items"],
    },
    confirmSummary: (args = {}) => `Add ${listText(said(args.items || []))} to your shopping list`.slice(0, 300),
    async execute(args, ctx) {
      const uid = uidOf(ctx);
      if (!uid) return NOT_SIGNED_IN;
      const raw = (Array.isArray(args.items) ? args.items : []).filter((x) => x !== null && x !== undefined);
      if (!raw.length) return { ok: false, needsArgs: ["items"] };
      if (raw.length > store.LIMITS.perRequest) {
        return { ok: false, error: `at most ${store.LIMITS.perRequest} things at a time — ask them to split it` };
      }
      if (repeatInTurn(uid, ctx, raw)) {
        return { ok: true, repeated: true, data: { alreadyAdded: true }, speak: "", note: "Already added a moment ago in this turn. Do not add it again." };
      }
      const clean = [];
      for (const r of raw) {
        try {
          clean.push(store.cleanItem(r, { strict: false }));
        } catch (_) { /* a line with no name: nothing to add */ }
      }
      if (!clean.length) return { ok: false, error: "no item names — ask what to add" };
      try {
        const out = await store.addItems(uid, clean, { source: "voice" });
        const open = out.items.filter((i) => !i.checked).length;
        const parts = [];
        if (out.added.length) parts.push(`Added ${listText(out.added.map((i) => spoken(i.name)))} to your shopping list.`);
        for (const m of out.merged.slice(0, 3)) {
          parts.push(`${m.name} was already there${m.amountText ? ` — now ${m.amountText}` : ""}.`);
        }
        return {
          ok: true,
          data: { added: out.added.map(brief), merged: out.merged.map(brief), onList: open },
          deviceAction: notice(ctx),
          speak: parts.join(" "),
          note: "Say it in one short sentence in the user's language. Nothing was bought or ordered.",
        };
      } catch (e) {
        if (e instanceof store.ShoppingError) return { ok: false, error: e.message };
        throw e;
      }
    },
  });

  registry.register({
    name: "shopping_list_show",
    risk: "low",
    effects: ["read"],
    description:
      "Read the user's shopping list — 'what's on my shopping list', 'what do I need to buy', 'is milk " +
      "on my list', 'show my list', 'what clothes are on my list'. category narrows it to one kind. On " +
      "the latest app it also opens the list screen (set open false when they only asked a question " +
      "about it). Read back names only, briefly; amounts or details only if asked.",
    inputSchema: {
      type: "object",
      properties: {
        category: { type: "string", description: `Optional, one kind: ${N.CATEGORY_IDS.join(", ")}.` },
        include_bought: { type: "boolean", description: "Also list what is already ticked as bought." },
        open: { type: "boolean", description: "Open the list screen (default true)." },
      },
    },
    async execute(args, ctx) {
      const uid = uidOf(ctx);
      if (!uid) return NOT_SIGNED_IN;
      let category = null;
      if (args.category) {
        category = N.normalizeCategory(args.category);
        if (!category) return { ok: false, error: `no such category — one of ${N.CATEGORY_IDS.join(", ")}` };
      }
      const all = await store.list(uid);
      const scoped = all.filter((i) => !category || i.category === category);
      const open = scoped.filter((i) => !i.checked);
      const shown = args.include_bought ? scoped : open;
      const groups = [];
      for (const i of shown) {
        let g = groups.find((x) => x.category === i.category);
        if (!g) groups.push((g = { category: i.category, label: N.categoryLabel(i.category), items: [] }));
        g.items.push(brief(i));
      }
      const where = category ? ` for ${N.categoryLabel(category).toLowerCase()}` : "";
      let speak;
      if (!open.length) speak = scoped.length ? `Everything on your list${where} is ticked off.` : `Your shopping list${where} is empty.`;
      else {
        const names = open.slice(0, 8).map((i) => spoken(i.name));
        const rest = open.length - names.length;
        speak = `You have ${open.length} ${open.length === 1 ? "thing" : "things"} on your list${where}: ` +
          `${rest > 0 ? `${names.join(", ")} and ${rest} more` : listText(names)}.`;
      }
      const screen = buildOf(ctx) >= APP_BUILD && args.open !== false
        ? { type: "open_app_screen", screen: "shopping_list", ...(category ? { category } : {}) }
        : undefined;
      return {
        ok: true,
        data: { toBuy: open.length, bought: scoped.length - open.length, groups },
        deviceAction: screen,
        speak,
        note: "Read names only, briefly, in the user's language — not the ids.",
      };
    },
  });

  registry.register({
    name: "shopping_list_remove",
    risk: "medium",
    effects: ["write:record"],
    description:
      "Take things OFF the user's shopping list — 'remove the charger from my list', 'I don't need " +
      "bread any more', 'delete the red kurti'. Pass each thing as they said it, with a detail when " +
      "there are two alike. For 'I bought it' use shopping_list_check instead.",
    inputSchema: {
      type: "object",
      properties: {
        items: { type: "array", items: { type: "string" }, description: "Each thing to remove, as the user said it." },
      },
      required: ["items"],
    },
    async execute(args, ctx) {
      const uid = uidOf(ctx);
      if (!uid) return NOT_SIGNED_IN;
      const names = said(args.items);
      if (!names.length) return { ok: false, needsArgs: ["items"] };
      const { hits, missing, unclear } = resolveSaid(await store.list(uid), names);
      if (hits.length) await store.removeMany(uid, hits.map((i) => i.id));
      const parts = [];
      if (hits.length) parts.push(`Removed ${listText(hits.map((i) => spoken(i.name)))} from your list.`);
      if (missing.length) parts.push(`${listText(missing)} ${missing.length === 1 ? "isn't" : "aren't"} on your list.`);
      return {
        ok: hits.length > 0 || !unclear.length,
        ...(hits.length || !unclear.length ? {} : { error: "which_one" }),
        data: { removed: hits.map((i) => i.name), notOnList: missing, whichOne: unclear },
        deviceAction: hits.length ? notice(ctx) : undefined,
        speak: parts.join(" "),
        ...(unclear.length ? { note: unclearNote(unclear) } : {}),
      };
    },
  });

  registry.register({
    name: "shopping_list_check",
    risk: "medium",
    effects: ["write:record"],
    description:
      "Tick things on the shopping list as BOUGHT — 'I bought the milk', 'got the onions and tomatoes', " +
      "'tick off the charger' — or untick them with bought false ('I didn't get the curd after all'). " +
      "Pass each thing as the user said it.",
    inputSchema: {
      type: "object",
      properties: {
        items: { type: "array", items: { type: "string" }, description: "Each thing, as the user said it." },
        bought: { type: "boolean", description: "true = bought / tick (default); false = untick." },
      },
      required: ["items"],
    },
    async execute(args, ctx) {
      const uid = uidOf(ctx);
      if (!uid) return NOT_SIGNED_IN;
      const names = said(args.items);
      if (!names.length) return { ok: false, needsArgs: ["items"] };
      const bought = args.bought !== false;
      const { hits, missing, unclear } = resolveSaid(await store.list(uid), names);
      if (hits.length) await store.setChecked(uid, hits.map((i) => i.id), bought);
      const parts = [];
      if (hits.length) {
        parts.push(bought
          ? `Ticked off ${listText(hits.map((i) => spoken(i.name)))}.`
          : `${listText(hits.map((i) => i.name))} ${hits.length === 1 ? "is" : "are"} back on your list.`);
      }
      if (missing.length) parts.push(`${listText(missing)} ${missing.length === 1 ? "isn't" : "aren't"} on your list.`);
      return {
        ok: hits.length > 0 || !unclear.length,
        ...(hits.length || !unclear.length ? {} : { error: "which_one" }),
        data: { changed: hits.map((i) => i.name), bought, notOnList: missing, whichOne: unclear },
        deviceAction: hits.length ? notice(ctx) : undefined,
        speak: parts.join(" "),
        ...(unclear.length ? { note: unclearNote(unclear) } : {}),
      };
    },
  });

  registry.register({
    name: "shopping_list_clear",
    risk: "medium",
    effects: ["write:record"],
    description:
      "Clear the shopping list: scope 'bought' (default) removes only what is ticked as bought — 'clear " +
      "the bought items', 'clean up my list'; scope 'all' empties the whole list and always asks the user " +
      "first — 'clear my whole shopping list', 'start a fresh list'.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["bought", "all"], description: "bought (default) or all." },
      },
    },
    async execute(args, ctx) {
      const uid = uidOf(ctx);
      if (!uid) return NOT_SIGNED_IN;
      if (args.scope === "all") {
        const n = (await store.list(uid)).length;
        if (!n) return { ok: true, data: { removed: 0 }, speak: "Your shopping list is already empty." };
        // Hand over to the high-risk tool: the card and the spoken yes
        // both key off its risk, so this is asked every time.
        return {
          ok: false,
          needsConfirmation: true,
          tool: "shopping_list_clear_all",
          args: {},
          summary: `Clear your whole shopping list (${n} ${n === 1 ? "item" : "items"})`,
        };
      }
      const removed = await store.clear(uid, { checkedOnly: true });
      return {
        ok: true,
        data: { removed },
        deviceAction: removed ? notice(ctx) : undefined,
        speak: removed ? `Cleared ${removed} bought ${removed === 1 ? "item" : "items"}.` : "Nothing on the list is ticked as bought yet.",
      };
    },
  });

  registry.register({
    name: "shopping_list_clear_all",
    risk: "high",
    effects: ["write:record", "irreversible"],
    unattended: false,
    description:
      "Empty the user's WHOLE shopping list, bought or not. Only when they want everything gone; it " +
      "always asks them first. For just the bought items use shopping_list_clear.",
    inputSchema: { type: "object", properties: {} },
    confirmSummary: () => "Clear your whole shopping list",
    async prepare(_args, ctx) {
      const uid = uidOf(ctx);
      if (!uid) return { error: "not signed in" };
      const n = (await store.list(uid)).length;
      if (!n) return { error: "the shopping list is already empty — say so" };
      return { summary: `Clear your whole shopping list (${n} ${n === 1 ? "item" : "items"})` };
    },
    async execute(_args, ctx) {
      const uid = uidOf(ctx);
      if (!uid) return NOT_SIGNED_IN;
      const removed = await store.clear(uid, { checkedOnly: false });
      return {
        ok: true,
        data: { removed },
        deviceAction: notice(ctx),
        speak: removed ? "Done — your shopping list is empty." : "Your shopping list was already empty.",
      };
    },
  });

  registry.register({
    name: "share_shopping_list",
    risk: "low",
    deviceAction: true,
    effects: ["device"],
    minAppBuild: APP_BUILD,
    description:
      "Send the shopping list on WhatsApp — to family, a friend or the local kirana / shop: 'send my " +
      "shopping list to Amma', 'share the grocery list with the kirana on WhatsApp', 'WhatsApp the list " +
      "to the family group'. The whole list, or one category. It opens WhatsApp with the list written; " +
      "the user taps Send themselves — never say it was sent.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Who, as the user said it ('Amma', 'the kirana', 'family group'). Omit if not said." },
        is_group: { type: "boolean", description: "True when it is a WhatsApp GROUP." },
        phone: { type: "string", description: "Only if the user dictated a number." },
        category: { type: "string", description: `Optional, only this kind: ${N.CATEGORY_IDS.join(", ")}.` },
      },
    },
    async execute(args, ctx) {
      const uid = uidOf(ctx);
      if (!uid) return NOT_SIGNED_IN;
      let category = null;
      if (args.category) {
        category = N.normalizeCategory(args.category);
        if (!category) return { ok: false, error: `no such category — one of ${N.CATEGORY_IDS.join(", ")}` };
      }
      const text = shareText(await store.list(uid), { category });
      if (!text) return { ok: false, error: "there is nothing left to buy on the list — say so" };

      if (args.is_group) {
        return {
          ok: true,
          data: { drafted: text, target: "group_picker" },
          deviceAction: whatsappAction(text),
          speak: `I've written the list — pick ${args.to || "the group"} and tap send.`,
        };
      }
      let phone = args.phone ? String(args.phone).replace(/[^\d+]/g, "") : null;
      let who = args.to || null;
      if (!phone && args.to) {
        const { resolveContact } = require("../users/resolve");
        const { match, candidates } = await resolveContact(uid, args.to);
        if (!match && candidates.length > 1) {
          return {
            ok: false,
            error: `there are ${candidates.length} contacts matching "${args.to}" — ${candidates.map((c) => c.name).join(", ")}. Ask which one.`,
          };
        }
        if (match) {
          phone = match.phone;
          who = match.name;
        }
      }
      if (!phone) {
        return {
          ok: true,
          data: { drafted: text, target: "picker", unresolved: args.to || null },
          deviceAction: whatsappAction(text),
          speak: args.to
            ? `I couldn't find ${args.to} in your contacts, so I've written the list — pick the chat and send.`
            : "I've written the list — pick the chat and send.",
        };
      }
      return {
        ok: true,
        data: { drafted: text, to: who, phone },
        deviceAction: whatsappAction(text, phone),
        speak: `The list is ready to send to ${who || "them"} — just tap send.`,
      };
    },
  });

  /** The lines a shop_from_list call means: named ones, else all unticked. */
  async function linesFor(uid, args) {
    const all = await store.list(uid);
    const names = said(args.items || []);
    if (!names.length) {
      const open = all.filter((i) => !i.checked);
      return open.length ? { lines: open } : { error: "there is nothing left to buy on the list — say so" };
    }
    const { hits, missing, unclear } = resolveSaid(all, names);
    if (unclear.length) return { error: unclearNote(unclear) };
    if (missing.length) {
      return { error: `${listText(missing)} ${missing.length === 1 ? "is" : "are"} not on the shopping list — ask whether to add ${missing.length === 1 ? "it" : "them"} first` };
    }
    return { lines: hits };
  }

  const askGroceryApp = (names) =>
    `Nothing was opened. Ask which app they use for groceries (${links.groceryLabels().join(", ")}), ` +
    `for ${listText(names.slice(0, 5))}${names.length > 5 ? " and the rest" : ""}; then call shop_from_list ` +
    "again with grocery_app set to their answer. It is remembered after that.";

  const appError = (e) =>
    e.code === "money_app"
      ? `${e.message}. Never open a payment or UPI app from the list: they pay inside the shopping app themselves. Ask which shopping app to use.`
      : e.message;

  registry.register({
    name: "shop_from_list",
    risk: "high",
    deviceAction: true,
    effects: ["device"],
    minAppBuild: APP_BUILD,
    unattended: false,
    description:
      "Shop for things on the user's shopping list in their shopping apps — 'order these', 'order my " +
      "groceries', 'buy the kurti', 'get everything on my list'. Each thing opens in the app that fits it " +
      "(groceries in their grocery app; clothes in Myntra/AJIO; electronics and most else in Amazon; " +
      "beauty in Nykaa; medicines in their pharmacy app or Amazon; a thing with its own link opens that " +
      "link), one at a time. Always asks first. It never pays: they choose and pay in the app. items: " +
      "only these (default: everything not yet bought). app: only when the user named one app for this " +
      "order. grocery_app: their answer when asked which app they use for groceries. Never a payment or UPI app.",
    inputSchema: {
      type: "object",
      properties: {
        items: { type: "array", items: { type: "string" }, description: "Only these things, as the user said them. Omit for everything not yet bought." },
        app: { type: "string", description: "One app the user named for this whole order ('on Amazon'). Omit otherwise." },
        grocery_app: { type: "string", description: "The app they use for groceries, when they just told you (Blinkit, Zepto, Swiggy Instamart, BigBasket, JioMart, Amazon Fresh, Flipkart Minutes)." },
      },
    },
    confirmSummary: (args = {}) => {
      const names = said(args.items || []);
      const what = names.length ? listText(names.slice(0, 5)) : "your shopping list";
      const where = args.app ? ` on ${args.app}` : args.grocery_app ? ` (groceries on ${args.grocery_app})` : " in your shopping apps";
      return `Open ${what}${where} — you choose and pay in the app`.slice(0, 300);
    },
    async prepare(args, ctx) {
      const uid = uidOf(ctx);
      if (!uid) return { error: "not signed in" };
      const r = await linesFor(uid, args);
      if (r.error) return { error: r.error };
      try {
        const h = await buildHandoff(uid, r.lines, { app: args.app || null, groceryApp: args.grocery_app || null, remember: false });
        if (h.needsGroceryApp.length) return { error: askGroceryApp(h.needsGroceryApp) };
        return { summary: `Open ${h.summary} — you choose and pay in the app` };
      } catch (e) {
        if (e.code === "money_app" || e.code === "unknown_app") return { error: appError(e) };
        throw e;
      }
    },
    async execute(args, ctx) {
      const uid = uidOf(ctx);
      if (!uid) return NOT_SIGNED_IN;
      const r = await linesFor(uid, args);
      if (r.error) return { ok: false, error: r.error };
      let h;
      try {
        h = await buildHandoff(uid, r.lines, { app: args.app || null, groceryApp: args.grocery_app || null });
      } catch (e) {
        if (e.code === "money_app" || e.code === "unknown_app") return { ok: false, error: appError(e) };
        throw e;
      }
      if (h.needsGroceryApp.length) {
        return {
          ok: false,
          error: "grocery_app_needed",
          data: { items: h.needsGroceryApp, apps: links.groceryLabels() },
          note: askGroceryApp(h.needsGroceryApp),
        };
      }
      const [first, ...rest] = h.groups;
      const total = h.groups.reduce((n, g) => n + g.items.length, 0);
      const then = rest.length ? `, then ${listText(rest.map((g) => g.label))}` : "";
      const next = total > 1 ? " — tap the notification for the next one" : "";
      return {
        ok: true,
        data: {
          groups: h.groups.map((g) => ({ app: g.app, label: g.label, items: g.items.map((i) => i.name) })),
          total,
          rememberedGroceryApp: h.rememberedGroceryApp,
        },
        deviceAction: h.action,
        speak: `Opening ${first.label} for ${spoken(first.items[0].name)}${then}${next}. You choose and pay in the app.`,
        note:
          "Say it in one short sentence. Nothing is ordered or paid: they pick and pay in each app. " +
          (h.rememberedGroceryApp ? `Their grocery app (${h.rememberedGroceryApp}) is now remembered.` : ""),
      };
    },
  });
}

module.exports = { registerShoppingTools, APP_BUILD, listText };
