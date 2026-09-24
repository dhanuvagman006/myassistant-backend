/**
 * AUTOMATION GUARDRAILS — what the assistant's hands may never do.
 *
 * The planner is a model reading another company's screen. Two things
 * follow: it can be wrong, and the screen can lie to it ("tap Pay to
 * continue" is just text on a page). So the lines that must never be
 * crossed are drawn HERE, in plain code that no screen text and no model
 * output can talk its way past:
 *
 *   • paying, placing or confirming an order or booking that costs money
 *   • sending or transferring money
 *   • typing a password, PIN, OTP, card, bank or ID number
 *   • sending a message to another person, or posting publicly
 *   • acting inside payment apps, system settings or the installer
 *
 * At any of these the run stops and hands the phone to the owner. The
 * app's accessibility service applies the same rules again on the device
 * (HariAccessibilityService.kt) — neither layer trusts the other.
 */

/* ------------------------------------------------------------------ *
 * WHAT THINGS ARE CALLED
 * ------------------------------------------------------------------ */

// The button that takes the money. Checked against the element's own
// label, and against a card's merged label only when it STARTS with one of
// these — restaurant cards carry offer banners ("Pay with HDFC, get 10%
// off") and those must stay tappable.
const PAY_ACTION =
  /^\s*(?:₹|rs\.?|inr)?\s*[\d,.]*\s*(?:pay\b|proceed to pay|proceed to buy|make (?:a |the )?payment|place (?:your |the )?order|confirm (?:and|&) pay|confirm (?:the |your )?(?:order|payment|purchase|booking|ride|pickup|trip)|complete (?:the |your )?(?:payment|purchase|order|booking)|buy now|checkout (?:and|&) pay|slide to pay|swipe to pay|pay (?:now|securely|using|via|with|₹|rs|inr)|continue to pay|book (?:now|ride|cab|tickets? now)|request (?:ride|cab|uber|ola)|confirm (?:uber|ola|rapido)\b)/i;

// Moving money anywhere, in any app.
const MONEY_ACTION =
  /\b(?:send money|transfer (?:money|funds|now)|withdraw|add money|pay to|request money|scan (?:and|&) pay|collect request|upi pin)\b/i;

// Account-level changes nobody asked an errand to make.
const ACCOUNT_ACTION =
  /^\s*(?:delete (?:my |your )?account|close (?:my |your )?account|deactivate|uninstall|log ?out|sign ?out|reset password|change password|remove (?:card|bank|account))\b/i;

// Posting in public.
const PUBLISH_ACTION = /^\s*(?:post|publish|tweet|share now|go live|upload)\s*$/i;

// A field the owner types into themselves. Written so that "Pincode" and
// "PIN code" — every Indian address form has one — stay fillable.
const CREDENTIAL_FIELD =
  /(?:pass(?:word|code|phrase)|\bm?pin\b(?!\s*-?\s*code)|\bupi\s*pin\b|\botp\b|one[\s-]?time|verification code|\bcvv\b|\bcvc\b|card\s*(?:number|no\b)|expiry|valid\s*(?:thru|till)|\bupi\s*id\b|\bvpa\b|net\s*banking|account\s*(?:number|no\b)|\bifsc\b|aadhaa?r|\bpan\b(?:\s*(?:card|number|no))?|security\s*(?:code|question)|secret)/i;

// Apps where the assistant never acts. Money apps first.
const PAYMENT_PKGS = new Set([
  "com.google.android.apps.nbu.paisa.user", // Google Pay
  "com.phonepe.app", "net.one97.paytm", "in.org.npci.upiapp", // PhonePe, Paytm, BHIM
  "com.dreamplug.androidapp", "in.amazon.mShop.android.shopping.pay",
  "com.mobikwik_new", "com.freecharge.android", "com.whatsapp.payments",
  "com.sbi.upi", "com.sbi.SBIFreedomPlus", "com.csam.icici.bank.imobile",
  "com.snapwork.hdfc", "com.axis.mobile", "com.msf.kbank.mobile",
]);
const SYSTEM_PKGS = new Set([
  "com.android.settings", "com.samsung.android.settings",
  "com.android.permissioncontroller", "com.google.android.permissioncontroller",
  "com.android.packageinstaller", "com.google.android.packageinstaller",
  "com.samsung.android.biometrics.app.setting", "com.android.systemui",
]);
const MESSAGING_PKGS = new Set([
  "com.whatsapp", "com.whatsapp.w4b", "org.telegram.messenger",
  "com.google.android.apps.messaging", "com.samsung.android.messaging",
  "com.google.android.gm", "com.instagram.android", "com.facebook.orca",
  "com.snapchat.android", "com.linkedin.android", "com.twitter.android",
  "com.facebook.katana", "com.microsoft.teams", "com.Slack",
]);
const SEND_ACTION = /^\s*(?:send|send message|reply|post|share)\s*$/i;

// Browsers a web task may run in.
const BROWSERS = [
  "com.android.chrome", "com.sec.android.app.sbrowser", "org.mozilla.firefox",
  "com.microsoft.emmx", "com.brave.browser", "com.opera.browser",
  "com.chrome.beta", "com.google.android.apps.chrome",
];

/* ------------------------------------------------------------------ *
 * READING AN ELEMENT
 * ------------------------------------------------------------------ */

const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();

/** What the element SAYS it is: its own text, else its description. */
function ownLabel(n) {
  return norm(n?.text) || norm(n?.desc);
}

/**
 * What a FIELD is for: hint, resource id, description and the label the
 * device found beside it. Never its current value — that is the owner's
 * data, not a description of the field.
 */
function fieldLabel(n) {
  return [n?.hint, n?.rid, n?.desc, n?.label].map(norm).filter(Boolean).join(" ");
}

/** The label a tap would be judged by. */
function tapLabels(n) {
  const own = ownLabel(n);
  const merged = norm(n?.label);
  return { own, merged };
}

/* ------------------------------------------------------------------ *
 * JUDGING AN ACTION
 * ------------------------------------------------------------------ */

const HANDOFF_TEXT = {
  payment: "the next step is payment",
  money: "the next step moves money",
  credential: "that field needs your password, PIN, OTP or card details",
  account: "that would change your account",
  publish: "that would post publicly",
  message_send: "the message is ready — sending it is your tap",
  blocked_app: "that screen is one I never act in",
};

/**
 * Would this action cross a line? Returns null when it is safe, else
 * { kind, reason } — kind is one of HANDOFF_TEXT's keys.
 *
 * @param action {type, id, text?}
 * @param screen {pkg, nodes:[...]}
 */
function checkAction(action, screen) {
  if (!action || typeof action !== "object") return null;
  const pkg = String(screen?.pkg || "");
  if (PAYMENT_PKGS.has(pkg) || SYSTEM_PKGS.has(pkg)) {
    return { kind: "blocked_app", reason: HANDOFF_TEXT.blocked_app };
  }
  const node = (screen?.nodes || []).find((n) => Number(n.id) === Number(action.id));

  if (action.type === "tap") {
    if (!node) return null; // the device refuses unknown ids on its own
    const { own, merged } = tapLabels(node);
    const short = merged && merged.length <= 40 ? merged : "";
    const judged = [own, short].filter(Boolean);
    if (judged.some((t) => PAY_ACTION.test(t)) || (merged && PAY_ACTION.test(merged))) {
      return { kind: "payment", reason: HANDOFF_TEXT.payment };
    }
    if (judged.some((t) => MONEY_ACTION.test(t))) {
      return { kind: "money", reason: HANDOFF_TEXT.money };
    }
    if (judged.some((t) => ACCOUNT_ACTION.test(t))) {
      return { kind: "account", reason: HANDOFF_TEXT.account };
    }
    if (judged.some((t) => PUBLISH_ACTION.test(t))) {
      return { kind: "publish", reason: HANDOFF_TEXT.publish };
    }
    if (MESSAGING_PKGS.has(pkg) && judged.some((t) => SEND_ACTION.test(t))) {
      return { kind: "message_send", reason: HANDOFF_TEXT.message_send };
    }
    return null;
  }

  if (action.type === "type") {
    if (!node) return null;
    if (node.pwd) return { kind: "credential", reason: HANDOFF_TEXT.credential };
    if (CREDENTIAL_FIELD.test(fieldLabel(node))) {
      return { kind: "credential", reason: HANDOFF_TEXT.credential };
    }
    // Typing a card-shaped number anywhere is the same thing.
    if (/\b(?:\d[ -]?){13,19}\b/.test(String(action.text || ""))) {
      return { kind: "credential", reason: HANDOFF_TEXT.credential };
    }
    return null;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * JUDGING A SCREEN
 * ------------------------------------------------------------------ */

// Payment-method rows are short labels ("UPI", "Credit & Debit cards",
// "Wallets"). Offer banners are sentences — counting only short nodes
// keeps a restaurant list with a Paytm offer from reading as checkout.
const PAY_METHODS = [
  /^upi\b|\bupi apps?\b|pay (?:by|via|using) (?:any )?upi/i,
  /credit\s*(?:&|and|\/)?\s*debit|credit card|debit card|^cards?$/i,
  /net\s*banking/i,
  /wallets?$/i,
  /cash on delivery|pay on delivery|^cod$/i,
  /\bemi\b/i,
  /pay\s*later|lazypay|simpl\b/i,
  /google pay|gpay|phonepe|paytm|amazon pay|cred\b/i,
];
const PAY_SCREEN_STRONG =
  /enter (?:your |the )?(?:upi |4[- ]digit |6[- ]digit )?(?:m?pin)\b|upi pin|enter cvv|card number|payment options|choose (?:a )?payment (?:method|option)|select (?:a )?payment (?:method|option)|pay securely/i;
const LOGIN_TEXT =
  /^(?:log ?in|sign ?in|login or sign ?up|enter (?:the )?otp|verify (?:the )?otp|verify (?:your )?(?:phone|mobile|number)|enter (?:your )?(?:mobile|phone) number|continue with (?:google|phone|email))\b/i;

/**
 * Is this screen one the owner must handle themselves? null, or
 * { kind: "payment"|"credential"|"blocked_app", reason }.
 */
function checkScreen(screen) {
  const pkg = String(screen?.pkg || "");
  if (PAYMENT_PKGS.has(pkg)) {
    return { kind: "payment", reason: "a payment app is open" };
  }
  if (SYSTEM_PKGS.has(pkg)) {
    return { kind: "blocked_app", reason: "a system screen (settings or a permission) is asking for you" };
  }
  const nodes = screen?.nodes || [];

  const texts = nodes.map((n) => ownLabel(n)).filter(Boolean);
  if (texts.some((t) => PAY_SCREEN_STRONG.test(t)) ||
      nodes.some((n) => n.edit && CREDENTIAL_FIELD.test(fieldLabel(n)) &&
        /cvv|card|upi|pin|net\s*banking/i.test(fieldLabel(n)))) {
    return { kind: "payment", reason: HANDOFF_TEXT.payment };
  }
  const short = texts.filter((t) => t.length <= 30);
  const methods = PAY_METHODS.filter((re) => short.some((t) => re.test(t))).length;
  if (methods >= 3) return { kind: "payment", reason: HANDOFF_TEXT.payment };

  const hasField = nodes.some((n) => n.edit);
  if (nodes.some((n) => n.pwd) ||
      (hasField && short.some((t) => LOGIN_TEXT.test(t)) &&
        nodes.some((n) => n.edit && /otp|password|mobile|phone|email|user/i.test(fieldLabel(n) + " " + ownLabel(n))))) {
    return { kind: "credential", reason: "the app wants you to sign in" };
  }
  return null;
}

/** The sentence the owner hears when a run stops at a guard. */
function handoffSentence(kind, appLabel) {
  const app = appLabel || "the app";
  switch (kind) {
    case "payment": return `It's ready for payment in ${app} — please complete that step yourself.`;
    case "money": return `The next step moves money, so I've stopped there for you to do it in ${app}.`;
    case "credential": return `${app} needs your sign-in, password or OTP — please enter it, then tell me to continue.`;
    case "account": return `That step changes your ${app} account, so I've left it for you.`;
    case "publish": return `It's ready to post — I never publish for you, so the last tap is yours.`;
    case "message_send": return `The message is written — tap Send when you're happy with it.`;
    case "blocked_app": return `A system screen needs your decision, so I've stopped there.`;
    default: return `I've stopped here for you to take over in ${app}.`;
  }
}

module.exports = {
  checkAction, checkScreen, handoffSentence,
  PAY_ACTION, MONEY_ACTION, CREDENTIAL_FIELD, BROWSERS,
  PAYMENT_PKGS, SYSTEM_PKGS, MESSAGING_PKGS, HANDOFF_TEXT,
};
