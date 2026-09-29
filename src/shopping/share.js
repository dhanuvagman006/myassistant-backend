/**
 * THE LIST AS A MESSAGE — tidy, WhatsApp-ready text for family or the
 * local kirana: a short header, the lines still to buy grouped by
 * category (bold headings), amounts, details, notes and links. No ids,
 * nothing bought, at most 3500 characters ("…and 4 more" when it is cut).
 *
 * whatsappAction() is the SAME deviceAction the send_whatsapp_message tool
 * returns: WhatsApp opens with the text written and the owner taps Send.
 */
const N = require("./normalize");

const MAX_CHARS = 3500;

function lineOf(item) {
  let s = `- ${item.name}`;
  const amount = item.amountText || N.amountText(item.amounts || [{ quantity: item.quantity, unit: item.unit }]);
  if (item.details) s += ` (${item.details})`;
  if (amount) s += ` — ${amount}`;
  if (item.note) s += ` · ${item.note}`;
  if (item.link) s += `\n  ${item.link}`;
  return s;
}

/**
 * @param {Array} items     ShoppingItems (store.list)
 * @param {object} o
 * @param {string} o.category  only this category id
 * @returns {string} "" when there is nothing left to buy
 */
function shareText(items, { category = null } = {}) {
  const open = (items || []).filter((i) => !i.checked && (!category || i.category === category));
  if (!open.length) return "";
  const n = open.length;
  const count = `${n} ${n === 1 ? "item" : "items"}`;
  const header = category
    ? `*Shopping list: ${N.categoryLabel(category)}* (${count})`
    : `*Shopping list* (${count})`;

  const groups = new Map();
  for (const i of [...open].sort((a, b) => N.categoryOrder(a.category) - N.categoryOrder(b.category))) {
    if (!groups.has(i.category)) groups.set(i.category, []);
    groups.get(i.category).push(i);
  }

  let out = header;
  let written = 0;
  const more = (left) => `\n\n…and ${left} more`;
  for (const [cat, list] of groups) {
    let block = category ? "\n" : `\n\n*${N.categoryLabel(cat)}*`;
    let any = false;
    for (const i of list) {
      const piece = `\n${lineOf(i)}`;
      // Always keep room for the "…and N more" line.
      if (out.length + block.length + piece.length + more(n).length > MAX_CHARS) {
        return (any ? out + block : out) + more(n - written);
      }
      block += piece;
      any = true;
      written++;
    }
    out += block;
  }
  return out;
}

/** send_whatsapp_message's deviceAction: a chat (by number) or the picker. */
function whatsappAction(text, phone = null) {
  const t = encodeURIComponent(text);
  return {
    type: "open_url",
    url: phone ? `whatsapp://send?phone=${phone}&text=${t}` : `whatsapp://send?text=${t}`,
  };
}

module.exports = { shareText, whatsappAction, MAX_CHARS };
