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
 *   • deleting or erasing anything
 *   • security settings (screen lock, accessibility, device admin, unknown
 *     apps, developer options, accounts, reset)
 *   • acting inside payment apps, the installer or permission pop-ups
 *
 * Everything else a person can do on their phone — any app, several apps
 * in a row, ordinary settings like Wi-Fi or brightness — is allowed.
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
  /^\s*(?:₹|rs\.?|inr)?\s*[\d,.]*\s*(?:pay\b|buy\b|proceed to pay|proceed to buy|make (?:a |the )?payment|place (?:your |the )?order|confirm (?:and|&) pay|confirm (?:the |your )?(?:order|payment|purchase|booking|ride|pickup|trip)|complete (?:the |your )?(?:payment|purchase|order|booking)|buy now|checkout (?:and|&) pay|slide to pay|swipe to pay|pay (?:now|securely|using|via|with|₹|rs|inr)|continue to pay|book (?:now|ride|cab|tickets? now)|request (?:ride|cab|uber|ola)|confirm (?:uber|ola|rapido)\b)/i;

// A button that is only a price — a paid app's "₹99.00" in the Play Store.
const PRICE_ONLY = /^\s*(?:₹|rs\.?|inr|\$|€|£)\s*[\d,.]+\s*$/i;

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
// Permission pop-ups: granting another app access is the owner's call.
const PERMISSION_PKGS = new Set([
  "com.android.permissioncontroller", "com.google.android.permissioncontroller",
]);
const INSTALLER_PKGS = new Set([
  "com.android.packageinstaller", "com.google.android.packageinstaller",
]);
// Never acted in at all.
const SYSTEM_PKGS = new Set([...PERMISSION_PKGS, ...INSTALLER_PKGS]);
// Settings is fine (Wi-Fi, brightness, sound…) — except what guards the
// phone itself, judged below.
const SETTINGS_PKGS = new Set([
  "com.android.settings", "com.samsung.android.settings",
  // Settings search runs in its own package — same rules.
  "com.android.settings.intelligence", "com.google.android.settings.intelligence",
  "com.samsung.android.biometrics.app.setting", "com.samsung.android.lool",
]);
const SECURITY_SETTING =
  /(?:accessibility|device admin|admin apps|install unknown|unknown apps|unknown sources|developer options|usb debugging|wireless debugging|screen lock|lock screen|biometric|fingerprint|face recognition|password|passkey|security|privacy|play protect|encryption|credential|\baccounts?\b|backup|\breset\b|factory|special (?:app )?access|app permissions|permission manager|default apps|sim (?:card )?lock|find my (?:mobile|device)|secure folder)/i;
// Deleting is final.
const DESTRUCTIVE_ACTION =
  /^\s*(?:delete|delete all|delete permanently|delete for everyone|erase|erase all|clear (?:data|storage|all data|cache and data)|format|wipe|factory (?:data )?reset|reset (?:phone|device|all|settings)|empty (?:trash|bin)|uninstall|remove account)\b/i;
// Consent is the owner's: declarations, "I agree", terms, and accepting
// cookies. (Rejecting cookies stays allowed — it is the private choice.)
const CONSENT_ACTION =
  /\b(?:i (?:hereby )?(?:agree|declare|accept|certify|confirm|consent|undertake)|agree (?:and|&) continue|agree to (?:the |all )?terms|accept (?:all|cookies|all cookies|the terms|terms)|terms (?:and|&) conditions|self[- ]declaration|declaration)\b/i;
// Proving you are human is, by definition, the human's job.
const CAPTCHA_TEXT =
  /captcha|i'?m not a robot|verify (?:that )?you are (?:a )?human|select all (?:images|squares)|security check/i;

// Apps the assistant never opens: anything that holds money.
const MONEY_APP_NAME =
  /\b(?:g ?pay|google pay|phone ?pe|paytm|bhim|cred|mobikwik|freecharge|amazon pay|yono|imobile|net ?banking|mobile banking|bank|upi|wallet)\b/i;
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
  destructive: "that would delete something",
  consent: "that is your consent to give",
  captcha: "a human check (CAPTCHA) is waiting for you",
  security: "that is a security setting",
  permission: "an app is asking for a permission",
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

  if (action.type === "open_app") {
    if (MONEY_APP_NAME.test(String(action.name || ""))) {
      return { kind: "money", reason: HANDOFF_TEXT.money };
    }
    return null;
  }

  if (action.type === "tap" || action.type === "long_press") {
    if (!node) return null; // the device refuses unknown ids on its own
    // Judged on what the tap would really press too: "₹312" is harmless
    // text, the "Proceed to Pay" button around it (up) is not.
    const up = Number.isInteger(node.up) && node.up >= 0
      ? (screen?.nodes || []).find((n) => Number(n.id) === node.up) : null;
    const judged = [];
    let mergedPay = false;
    for (const n of [node, up].filter(Boolean)) {
      const { own, merged } = tapLabels(n);
      judged.push(...[own, merged && merged.length <= 40 ? merged : ""].filter(Boolean));
      if (merged && PAY_ACTION.test(merged)) mergedPay = true;
    }
    if (mergedPay || judged.some((t) => PAY_ACTION.test(t) || PRICE_ONLY.test(t))) {
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
    // Declarations and terms: a tick or a button, judged on the whole
    // label — "I hereby declare that the information…" is long.
    if ([node, up].filter(Boolean).some((n) => CONSENT_ACTION.test(ownLabel(n)) ||
        (n.check && CONSENT_ACTION.test(norm(n.label))))) {
      return { kind: "consent", reason: HANDOFF_TEXT.consent };
    }
    if (judged.some((t) => DESTRUCTIVE_ACTION.test(t))) {
      return { kind: "destructive", reason: HANDOFF_TEXT.destructive };
    }
    if (SETTINGS_PKGS.has(pkg)) {
      const all = [node, up].filter(Boolean).flatMap((n) => [ownLabel(n), norm(n.label)]);
      if (all.some((t) => SECURITY_SETTING.test(t))) {
        return { kind: "security", reason: HANDOFF_TEXT.security };
      }
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
  if (PERMISSION_PKGS.has(pkg)) {
    return { kind: "permission", reason: HANDOFF_TEXT.permission };
  }
  if (INSTALLER_PKGS.has(pkg)) {
    return { kind: "blocked_app", reason: "the installer is asking for you" };
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

  if (texts.some((t) => CAPTCHA_TEXT.test(t)) || nodes.some((n) => CAPTCHA_TEXT.test(fieldLabel(n)))) {
    return { kind: "captcha", reason: HANDOFF_TEXT.captcha };
  }

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
    case "destructive": return `The next step deletes something, so I've left that tap to you.`;
    case "security": return `That's a security setting — I never change those, so it's over to you.`;
    case "permission": return `An app is asking for a permission — that's your decision, so I've stopped there.`;
    case "returned": return `You came back to me, so I stopped there.`;
    case "consent": return `Everything I could fill is filled — the declaration or "I agree" is yours to tick, then submit.`;
    case "captcha": return `There's a human check (CAPTCHA) on ${app} — please solve it and submit.`;
    default: return `I've stopped here for you to take over in ${app}.`;
  }
}

module.exports = {
  checkAction, checkScreen, handoffSentence,
  PAY_ACTION, MONEY_ACTION, CREDENTIAL_FIELD, BROWSERS,
  PAYMENT_PKGS, SYSTEM_PKGS, SETTINGS_PKGS, MESSAGING_PKGS, HANDOFF_TEXT,
};
