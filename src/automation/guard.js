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
 *   • installing an app the owner did not ask for
 *
 * Everything else a person can do on their phone — any app, several apps
 * in a row, ordinary settings like Wi-Fi or brightness — is allowed.
 *
 * A step the guard refuses is recorded as a refused step and the planner
 * picks another way (service.js); a second refusal, or a screen that is
 * itself the owner's (payment, sign-in), hands the phone to the owner.
 * The app's accessibility service applies the same rules again on the
 * device (HariAccessibilityService.kt) — neither layer trusts the other.
 */

/* ------------------------------------------------------------------ *
 * WHAT THINGS ARE CALLED
 * ------------------------------------------------------------------ */

// The button that takes the money. Checked against the element's own
// label, and against a card's merged label only when it STARTS with one of
// these — restaurant cards carry offer banners ("Pay with HDFC, get 10%
// off") and those must stay tappable.
// "Buy" is the pay button; "BUY 1 GET 1", "Buy again", "Buy 2 at ₹99" are
// offer cards and reorder rows that only open a menu or a product. Read
// as payment they ended food and grocery runs with "It's ready for
// payment" and nothing in the cart (probe of real labels, 2026-09-24).
// "Buy more storage" is a purchase, not an offer card. A trial and a
// one-tap buy start a charge too.
const PAY_ACTION =
  /^\s*(?:₹|rs\.?|inr)?\s*[\d,.]*\s*(?:pay\b|buy(?! (?:\d+ get|again|it again|\d+ at))\b|proceed to pay|proceed to buy|make (?:a |the )?payment|place (?:your |the )?order|confirm (?:and|&) pay|confirm (?:the |your )?(?:order|payment|purchase|booking|ride|pickup|trip)|complete (?:the |your )?(?:payment|purchase|order|booking)|buy now|checkout (?:and|&) pay|slide to pay|swipe to pay|pay (?:now|securely|using|via|with|₹|rs|inr)|continue to pay|book (?:now|ride|cab|tickets? now)|request (?:ride|cab|uber|ola)|confirm (?:uber|ola|rapido)\b|(?:1|one)[- ]tap buy|start (?:your |a |the )?(?:free )?trial|subscribe (?:for|at) (?:₹|rs|inr|\$|\d))/i;

// A checkout bar's merged label puts the price and the item count BEFORE
// its button: "₹312 · Proceed to Pay", "₹312 · TOTAL · Place Order",
// "1 item · ₹249 · Place order" (the phone joins a card's texts with
// " · "). Those leading parts are skipped before PAY_ACTION is tried.
// Only a real price (with its currency) or a count is skipped — a
// restaurant card's "4.2 · Pay with HDFC, get 10% off" still starts with
// its rating and stays tappable.
const BAR_PART =
  "(?:(?:grand |sub)?total|to pay|amount payable|\\d+\\s*items?|(?:(?:grand |sub)?total\\s*|to pay\\s*)?(?:₹|rs\\.?|inr)\\s*[\\d,.]+(?:\\s*(?:total|items?))?)";
const BAR_PREFIX = new RegExp(`^\\s*(?:${BAR_PART}\\s*[·•|]\\s*)+`, "i");
/** Is this label a pay button — on its own, or after a checkout bar's price? */
function payLabel(t) {
  const s = norm(t);
  return !!s && (PAY_ACTION.test(s) || PAY_ACTION.test(s.replace(BAR_PREFIX, "")));
}

// A button that is only a price — a paid app's "₹99.00" in the app
// store, an in-app purchase in a game: tapping the price buys. Judged on
// what the tap really presses (the element, or the tappable container
// around a bare price text). A price that is only text on a menu row —
// nothing tappable under it, or inside a dish card that says more than
// the price — is not a buy button.
const PRICE_ONLY = /^\s*(?:₹|rs\.?|inr|\$|€|£)\s*[\d,.]+\s*$/i;
const STORE_PKGS = new Set(["com.android.vending", "com.sec.android.app.samsungapps"]);
// The app store's own billing sheet: "Subscribe" and "1-tap buy" charge
// the owner's account there (elsewhere "Subscribe" follows a channel).
const STORE_PAY =
  /^\s*(?:subscribe|(?:1|one)[- ]tap buy|buy with\b|purchase(?! history)|confirm purchase|start (?:your |a )?(?:free )?trial)\b/i;
// Installing is the owner's word: "install X" / "download X", and only X.
// A run that wanders into the app store for anything else — or onto an
// ad beside X — must not press Install or Update on its own (the
// directive carries may_install and install_app for the phone too).
const INSTALL_ACTION =
  /^\s*(?:install|update|update all|get|enable|install on (?:this|more) devices?)\s*$/i;

// Moving money anywhere, in any app.
const MONEY_ACTION =
  /\b(?:send money|transfer (?:money|funds|now)|withdraw|add money|pay to|request money|scan (?:and|&) pay|collect request|upi pin)\b/i;

// Account-level changes nobody asked an errand to make. ("Uninstall" is
// not an account change — it is deleting an app, judged as destructive
// below; calling it "your account" told the owner the wrong thing.)
const ACCOUNT_ACTION =
  /^\s*(?:delete (?:my |your )?account|close (?:my |your )?account|deactivate|log ?out|sign ?out|reset password|change password|remove (?:card|bank|account))\b/i;

// Posting in public. A repost goes out at once, from the feed itself.
const PUBLISH_ACTION = /^\s*(?:post|publish|tweet|share now|go live|upload|repost|retweet)\s*$/i;

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
// Phone makers ship their own installer and permission screens
// (com.miui.packageinstaller, …). They show the same install / uninstall
// / allow dialogs, so they are judged by the name's ending, not a list
// that can never be complete.
const isInstallerPkg = (p) => INSTALLER_PKGS.has(p) || /\.packageinstaller$/i.test(p);
const isPermissionPkg = (p) => PERMISSION_PKGS.has(p) || /\.permissioncontroller$/i.test(p);
const isSystemPkg = (p) => isInstallerPkg(p) || isPermissionPkg(p);
// Settings is fine (Wi-Fi, brightness, sound…) — except what guards the
// phone itself, judged below.
const SETTINGS_PKGS = new Set([
  "com.android.settings", "com.samsung.android.settings",
  // Settings search runs in its own package — same rules.
  "com.android.settings.intelligence", "com.google.android.settings.intelligence",
  "com.samsung.android.biometrics.app.setting", "com.samsung.android.lool",
]);
// Judged on a Settings row's TITLE only. Rows carry a subtitle listing
// what is inside ("System · Languages, gestures, time, backup", "Device
// care · Battery, storage, memory, security"), and reading those made
// every ordinary row look like a security setting (probe, 2026-09-24).
const SECURITY_SETTING =
  /(?:accessibility|device admin|admin apps|install unknown|unknown apps|unknown sources|developer options|usb debugging|wireless debugging|screen lock|lock screen|biometric|fingerprint|face recognition|password|passkey|security|privacy|play protect|encryption|credential|\baccounts?\b|backup|\breset\b|factory|special (?:app )?access|app permissions|permission manager|default apps|sim (?:card )?lock|find my (?:mobile|device)|secure folder)/i;
// Deleting is final. "Clear all filters" is not deleting anything.
const DESTRUCTIVE_ACTION =
  /^\s*(?:delete|delete all|delete permanently|delete for everyone|erase|erase all|clear (?:data|storage|all data|cache and data)|format|wipe|factory (?:data )?reset|reset (?:phone|device|all|settings)|empty (?:trash|bin)|uninstall|remove account|close all|clear all(?! filters)|end all|force stop)\b/i;
// Checked first, so these never count as deleting.
const SAFE_ACTION = /^\s*(?:clear|reset) (?:all )?filters?\s*$/i;
// In Settings, turning a built-in app off is the same kind of step as
// uninstalling it: the owner's tap (App info → Disable).
const DISABLE_APP = /^\s*(?:disable|disable app|turn off app)\s*$/i;
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
// Inside a messaging app. "Reply" and "Share" under a post in the feed
// only OPEN a composer or a share sheet — nothing has been written yet —
// so they stay tappable; "Post" is judged as publishing above.
const SEND_ACTION = /^\s*(?:send|send message|share now)\s*$/i;
// …but on a COMPOSE screen the same words publish: a new post's final
// "Share", a story's "Your story", the reply box's "Reply" button. A
// compose screen is one with a caption / reply / comment box, a box that
// already holds text, or a "New post" heading.
const COMPOSE_SUBMIT =
  /^\s*(?:share|reply|your story|share to (?:your )?story|close friends)\s*$/i;
const COMPOSE_FIELD =
  /caption|reply|comment|what'?s happening|what'?s on your mind|what do you want to talk about|start a post|post your|add a (?:note|thought)|tweet|thread|write (?:a|something|your)/i;
// (Not "Your story" alone: the feed's story tray is labelled that too. A
// story's editor shows "Close Friends" beside it.)
const COMPOSE_TEXT =
  /^\s*(?:new (?:post|reel|story|thread|tweet)|write a caption|add a caption|post your reply|replying to\b|close friends\s*$)/i;
// Social apps: what they publish is public, so the kind is "publish".
const SOCIAL_PKGS = new Set([
  "com.instagram.android", "com.twitter.android", "com.facebook.katana", "com.linkedin.android",
  "com.snapchat.android",
]);
// A button that says exactly "Send" sends in EVERY app — Signal, an SMS
// app we have never heard of, or a notification's inline reply in the
// status bar (com.android.systemui). A package list can never be complete.
const SEND_BUTTON = /^\s*(?:send|send message|send now|send reply)\s*$/i;
// The notification shade: its text fields are inline replies to people.
const SYSTEM_UI = "com.android.systemui";
// Enter on the keyboard is a SEND in chat boxes and comment fields, so a
// typed text is submitted with Enter only in a search-like field
// (search, destination, address bar); anywhere else the planner taps the
// field's own button, which the guard can judge.
const SUBMITTABLE =
  /search|find|query|where to|destination|drop|pick ?up|location|pin ?code|url|address bar|web address|go to|\bq\b/i;

// An OTP screen, even when the digit boxes have no label at all — the
// words around them say what they are for. "Get OTP" / "Send OTP" on a
// sign-in sheet are not this; "Enter OTP", "code sent to +91…" are.
const OTP_ALTS = "otp|one[- ]time (?:password|passcode|pin|code)|verification code|\\d[- ]digit code";
const OTP_WORD = `(?:${OTP_ALTS})`;
const OTP_SCREEN = new RegExp(
  `\\b(?:enter|verify|type|resend|re-send|didn'?t (?:get|receive))\\b.{0,20}\\b${OTP_WORD}` +
  `|\\b(?:${OTP_ALTS}|code)\\b.{0,20}\\b(?:sent to|has been sent|we sent|we've sent|sent on)\\b` +
  `|\\bsent (?:you )?(?:an? )?(?:otp|code|verification code)\\b` +
  `|^\\s*${OTP_WORD}\\s*$`, "i");

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
  install: "installing an app needs your go-ahead",
};

const flat = (s) => norm(s).toLowerCase().replace(/[^a-z0-9]+/g, "");
const AD_PART = /^(?:ad|ads|sponsored|promoted|suggested for you)$/i;
const isIn = (b, x, y) => Array.isArray(b) && x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];

/**
 * Is this Install button the one for the app the owner asked to install
 * (opts.installApp — see intent.installTarget)? "Download my invoice"
 * asks for no app at all, and an ad or a "you might also like" row is
 * someone else's app. A result card names its app first ("Instagram ·
 * Meta · 4.3"); the app's own page has its name as a heading.
 */
function installAsked(opts, node, up, screen) {
  const want = flat(opts?.installApp);
  if (want.length < 2) return false;
  const nodes = screen?.nodes || [];
  // The smallest card around the button, when the button sits in one.
  const b = node?.b;
  const cx = Array.isArray(b) ? (b[0] + b[2]) / 2 : null;
  const cy = Array.isArray(b) ? (b[1] + b[3]) / 2 : null;
  const cards = [up, ...nodes.filter((n) => n !== node && n.click && cx != null && isIn(n.b, cx, cy))]
    .filter((n) => n && norm(n.label).split(/\s*[·•|]\s*/).filter(Boolean).length > 1)
    .sort((p, q) => (p.b ? (p.b[2] - p.b[0]) * (p.b[3] - p.b[1]) : 0) - (q.b ? (q.b[2] - q.b[0]) * (q.b[3] - q.b[1]) : 0));
  if (cards.length) {
    const parts = norm(cards[0].label).split(/\s*[·•|]\s*/).filter(Boolean);
    return !parts.some((p) => AD_PART.test(p)) && parts.some((p) => flat(p).startsWith(want));
  }
  // The app's own page: a short heading that starts with its name
  // ("Zomato: Food Delivery & Dining").
  return nodes.some((n) => { const t = ownLabel(n); return t && t.length <= 60 && flat(t).startsWith(want); });
}

/**
 * A compose screen in a social or messaging app: a caption, reply or
 * comment box, a box that already holds text (not a search box), or a
 * "New post" heading. There "Share" and "Reply" publish.
 */
function composeScreen(screen) {
  return (screen?.nodes || []).some((n) => {
    if (n.edit) {
      const f = fieldLabel(n);
      if (/search/i.test(f)) return false;
      return !!norm(n.text) || COMPOSE_FIELD.test(f);
    }
    const t = ownLabel(n);
    return !!t && t.length <= 40 && COMPOSE_TEXT.test(t);
  });
}

/** Every text an element shows, for screen-wide checks. */
function screenTexts(screen) {
  return (screen?.nodes || []).flatMap((n) => [ownLabel(n), norm(n.label)]).filter(Boolean);
}

/** A Settings row is judged by its title: its own text, or the first
 *  part of the merged "Title · subtitle" label. */
function rowTitle(n) {
  return ownLabel(n) || norm(n?.label).split(/\s+[·•|]\s+/)[0] || "";
}

// A sign-in form: a login field under a sign-in heading, however many
// fields it has. Two look-alikes are not (probe, 2026-09-24): a
// registration form (it asks for a NAME — a sign-in never does) and a
// one- or two-field sheet with "Skip" / "Not now" / "×", which the
// planner dismisses and carries on — though signing in ON it (typing the
// number, "Continue with Google") is still the owner's step. A search box
// ("Search for mobiles, phones…") is no login field.
const LOGIN_FIELD = /\botp\b|password|passcode|\b(?:mobile|phone|cell)\b|e-?mail|user ?name|user ?id|login id/i;
const PROFILE_FIELD = /(?<!user ?)\bname\b|date of birth|\bdob\b|\bgender\b/i;
const isLoginField = (n) => !!n.edit && LOGIN_FIELD.test(fieldLabel(n)) && !/search/i.test(fieldLabel(n));
const isProfileField = (n) => !!n.edit && PROFILE_FIELD.test(fieldLabel(n));
const DISMISS = /^\s*(?:skip|skip for now|not now|later|maybe later|close|×|✕|cancel|no thanks|continue as guest|explore|browse as guest)\s*$/i;
function loginShaped(screen) {
  const nodes = screen?.nodes || [];
  const edits = nodes.filter((n) => n.edit);
  if (!edits.length || edits.some(isProfileField)) return false;
  const short = nodes.map((n) => ownLabel(n)).filter((t) => t && t.length <= 30);
  return short.some((t) => LOGIN_TEXT.test(t));
}
function realLogin(screen) {
  const nodes = screen?.nodes || [];
  if (!loginShaped(screen) || !nodes.some(isLoginField)) return false;
  const skippable = nodes.filter((n) => n.edit).length <= 2 && nodes.some((n) => DISMISS.test(ownLabel(n)));
  return !skippable;
}
// Signing in with one tap: the owner's account goes to the app.
// ("Continue as guest" is a way round signing in, not a way in.)
const SSO_ACTION =
  /^\s*(?:(?:continue|sign ?in|log ?in|login|sign ?up|register|connect) (?:with|using|via|through) (?:google|facebook|apple|phone|mobile|e-?mail|truecaller|microsoft|x|twitter|github|linkedin|your (?:phone|mobile|e-?mail|google))|continue as (?!(?:a )?guest\b)\S|use (?:another|a different|this) account|add (?:another )?account)/i;
// Google's own account chooser and sign-in sheets run in Play services.
const ACCOUNT_PKGS = new Set(["com.google.android.gms"]);
const ACCOUNT_SCREEN =
  /choose an account|sign in with google|continue with google|to continue to\b|use another account|add another account|\bwants to access your google account\b/i;
const EMAILISH = /[\w.+-]+@[\w-]+\.[\w.-]+/;

/**
 * May this typed text be sent with the keyboard's Enter? Only in a
 * search-like field, and never in a messaging app or the notification
 * shade — there Enter is Send.
 */
function maySubmit(action, screen) {
  const pkg = String(screen?.pkg || "");
  if (MESSAGING_PKGS.has(pkg) || pkg === SYSTEM_UI) return false;
  const node = (screen?.nodes || []).find((n) => Number(n.id) === Number(action?.id));
  if (!node) return false;
  return SUBMITTABLE.test([fieldLabel(node), norm(node.cls)].join(" "));
}

/**
 * Would this action cross a line? Returns null when it is safe, else
 * { kind, reason } — kind is one of HANDOFF_TEXT's keys.
 *
 * @param action {type, id, text?}
 * @param screen {pkg, nodes:[...]}
 * @param opts   {installApp} — the app the task itself asks to install
 *               (intent.installTarget), or "" — Install / Update in the
 *               app store is pressed only on that app's own listing
 */
function checkAction(action, screen, opts = {}) {
  if (!action || typeof action !== "object") return null;
  const pkg = String(screen?.pkg || "");
  if (PAYMENT_PKGS.has(pkg) || isSystemPkg(pkg)) {
    return { kind: "blocked_app", reason: HANDOFF_TEXT.blocked_app };
  }
  const node = (screen?.nodes || []).find((n) => Number(n.id) === Number(action.id));

  if (action.type === "open_app") {
    if (MONEY_APP_NAME.test(String(action.name || ""))) {
      return { kind: "money", reason: HANDOFF_TEXT.money };
    }
    return null;
  }

  // A tap on a point of the screenshot: judged as the element under the
  // point (when the screen has one) AND as what the planner says it is.
  if (action.type === "tap_xy") {
    const x = Number(action.x), y = Number(action.y);
    const under = (screen?.nodes || [])
      .filter((n) => Array.isArray(n.b) && x >= n.b[0] && x <= n.b[2] && y >= n.b[1] && y <= n.b[3])
      .sort((a, b) => (a.b[2] - a.b[0]) * (a.b[3] - a.b[1]) - (b.b[2] - b.b[0]) * (b.b[3] - b.b[1]))[0];
    // The planner's own words, judged as a button label: "Send button",
    // "the Pay icon" are "Send" and "Pay".
    const said = {
      id: -1, click: 1,
      text: String(action.label || "").replace(/^\s*(?:the|a|an)\s+/i, "")
        .replace(/\s+(?:button|icon|arrow|key|tab|option|link)s?\s*$/i, "").trim(),
    };
    for (const n of [said, under].filter(Boolean)) {
      const v = checkAction({ type: "tap", id: n.id }, { pkg, nodes: [...(screen?.nodes || []), said] }, opts);
      if (v) return v;
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
      if (merged && payLabel(merged)) mergedPay = true;
    }
    const own = [node, up].filter(Boolean).flatMap((n) => [ownLabel(n), norm(n.desc)]).filter(Boolean);
    const store = STORE_PKGS.has(pkg);
    // What the tap really presses: the element when it is tappable, else
    // the tappable container around it — and when that container says
    // nothing itself, the words tapped inside it. A bare price there is a
    // buy button, in any app.
    const pressed = node.click ? node : up;
    const pressedSays = pressed ? ownLabel(pressed) || norm(pressed.label) || ownLabel(node) : "";
    if (mergedPay || PRICE_ONLY.test(pressedSays) ||
        judged.some((t) => payLabel(t) || (store && (PRICE_ONLY.test(t) || STORE_PAY.test(t))))) {
      return { kind: "payment", reason: HANDOFF_TEXT.payment };
    }
    if (judged.some((t) => MONEY_ACTION.test(t))) {
      return { kind: "money", reason: HANDOFF_TEXT.money };
    }
    // "Continue with Google", "Continue as Ravi", or the owner's account
    // in Google's own chooser: signing in with one tap is the owner's.
    if (judged.some((t) => SSO_ACTION.test(t)) ||
        (ACCOUNT_PKGS.has(pkg) && [...judged, ...own].some((t) => EMAILISH.test(t)))) {
      return { kind: "credential", reason: "signing in is yours to do" };
    }
    if (store && judged.some((t) => INSTALL_ACTION.test(t)) && !installAsked(opts, node, up, screen)) {
      return { kind: "install", reason: HANDOFF_TEXT.install };
    }
    if (judged.some((t) => ACCOUNT_ACTION.test(t))) {
      return { kind: "account", reason: HANDOFF_TEXT.account };
    }
    if (judged.some((t) => PUBLISH_ACTION.test(t))) {
      return { kind: "publish", reason: HANDOFF_TEXT.publish };
    }
    // On a compose screen a social app's "Share" / "Reply" publishes (in a
    // chat app it sends); from the feed it only opens a composer.
    if (MESSAGING_PKGS.has(pkg) && [...judged, ...own].some((t) => COMPOSE_SUBMIT.test(t)) && composeScreen(screen)) {
      return SOCIAL_PKGS.has(pkg)
        ? { kind: "publish", reason: HANDOFF_TEXT.publish }
        : { kind: "message_send", reason: HANDOFF_TEXT.message_send };
    }
    // "Send" itself, in any app at all; the wider list in messaging apps.
    if (own.some((t) => SEND_BUTTON.test(t)) ||
        (MESSAGING_PKGS.has(pkg) && judged.some((t) => SEND_ACTION.test(t)))) {
      return { kind: "message_send", reason: HANDOFF_TEXT.message_send };
    }
    // Declarations and terms: a tick or a button, judged on the whole
    // label — "I hereby declare that the information…" is long.
    if ([node, up].filter(Boolean).some((n) => CONSENT_ACTION.test(ownLabel(n)) ||
        (n.check && CONSENT_ACTION.test(norm(n.label))))) {
      return { kind: "consent", reason: HANDOFF_TEXT.consent };
    }
    if (judged.some((t) => !SAFE_ACTION.test(t) && DESTRUCTIVE_ACTION.test(t))) {
      return { kind: "destructive", reason: HANDOFF_TEXT.destructive };
    }
    if (SETTINGS_PKGS.has(pkg)) {
      if (own.some((t) => DISABLE_APP.test(t))) {
        return { kind: "destructive", reason: HANDOFF_TEXT.destructive };
      }
      if ([node, up].filter(Boolean).some((n) => SECURITY_SETTING.test(rowTitle(n)))) {
        return { kind: "security", reason: HANDOFF_TEXT.security };
      }
    }
    return null;
  }

  if (action.type === "type") {
    // The notification shade's text fields are inline replies to people.
    if (pkg === SYSTEM_UI) return { kind: "message_send", reason: HANDOFF_TEXT.message_send };
    if (!node) return null;
    if (node.pwd) return { kind: "credential", reason: HANDOFF_TEXT.credential };
    if (CREDENTIAL_FIELD.test(fieldLabel(node))) {
      return { kind: "credential", reason: HANDOFF_TEXT.credential };
    }
    const text = String(action.text || "");
    // Typing a card-shaped number anywhere is the same thing.
    if (/\b(?:\d[ -]?){13,19}\b/.test(text)) {
      return { kind: "credential", reason: HANDOFF_TEXT.credential };
    }
    // An OTP typed into unlabeled digit boxes: the screen says what it is.
    if (/^\s*\d{4,8}\s*$/.test(text) && screenTexts(screen).some((t) => t.length <= 120 && OTP_SCREEN.test(t))) {
      return { kind: "credential", reason: HANDOFF_TEXT.credential };
    }
    // A skippable sign-in sheet is left for the planner to dismiss — but
    // signing in on it (a phone number or email into its login field) is
    // still the owner's step.
    if (loginShaped(screen) && (isLoginField(node) || /@|^\s*\+?[\d\s()-]{8,16}\s*$/.test(text))) {
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
/**
 * Judged on the app alone, before anything is read from its screen: a
 * payment app, a permission pop-up or the installer is the owner's even
 * when it shows no elements (payment screens often hide them).
 */
function checkPackage(pkg) {
  const p = String(pkg || "");
  if (PAYMENT_PKGS.has(p)) return { kind: "payment", reason: "a payment app is open" };
  if (isPermissionPkg(p)) return { kind: "permission", reason: HANDOFF_TEXT.permission };
  if (isInstallerPkg(p)) return { kind: "blocked_app", reason: "the installer is asking for you" };
  return null;
}

function checkScreen(screen) {
  const byPkg = checkPackage(screen?.pkg);
  if (byPkg) return byPkg;
  const nodes = screen?.nodes || [];

  const texts = nodes.map((n) => ownLabel(n)).filter(Boolean);
  if (texts.some((t) => PAY_SCREEN_STRONG.test(t)) ||
      nodes.some((n) => n.edit && CREDENTIAL_FIELD.test(fieldLabel(n)) &&
        /cvv|card|upi|pin|net\s*banking/i.test(fieldLabel(n)))) {
    return { kind: "payment", reason: HANDOFF_TEXT.payment };
  }
  // Payment methods as a list of options. Offer chips on a restaurant
  // list ("Credit card offers", "Wallets", "EMI") name methods too, so
  // offers are not counted, and three methods need a pay button or a
  // ticked option beside them; four real method rows are a checkout.
  const OFFERISH = /offers?\b|cashback|%|\boff\b|discount|deal/i;
  const rows = nodes.map((n) => ({ t: ownLabel(n), picked: !!(n.check || n.sel) }))
    .filter((x) => x.t && x.t.length <= 30 && !OFFERISH.test(x.t));
  const methods = PAY_METHODS.filter((re) => rows.some((x) => re.test(x.t))).length;
  const picked = rows.some((x) => x.picked && PAY_METHODS.some((re) => re.test(x.t)));
  const payButton = nodes.some((n) => (n.click || n.cls === "Button") && payLabel(ownLabel(n) || n.label));
  if (methods >= 4 || (methods >= 3 && (picked || payButton))) {
    return { kind: "payment", reason: HANDOFF_TEXT.payment };
  }

  if (texts.some((t) => CAPTCHA_TEXT.test(t)) || nodes.some((n) => CAPTCHA_TEXT.test(fieldLabel(n)))) {
    return { kind: "captcha", reason: HANDOFF_TEXT.captcha };
  }

  // An OTP to type, even into boxes that carry no label at all.
  if (nodes.some((n) => n.edit) &&
      screenTexts(screen).some((t) => t.length <= 120 && OTP_SCREEN.test(t))) {
    return { kind: "credential", reason: "the app wants an OTP" };
  }
  if (nodes.some((n) => n.pwd) || realLogin(screen)) {
    return { kind: "credential", reason: "the app wants you to sign in" };
  }
  // Google's account chooser or sign-in sheet: picking the owner's
  // account signs them in to the app.
  if (ACCOUNT_PKGS.has(String(screen?.pkg || "")) &&
      screenTexts(screen).some((t) => t.length <= 120 && ACCOUNT_SCREEN.test(t))) {
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
    // No "tell me to continue": a finished run cannot be picked up again
    // by a word, and the sentence must not promise what can't happen.
    // (A phone that can resume gets the owner_step sentence instead.)
    case "credential": return `${app} needs your sign-in, password or OTP — please enter it yourself, then ask me again.`;
    case "install": return `Installing an app is your call — ask me to install it and I will.`;
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
  checkAction, checkScreen, checkPackage, handoffSentence, maySubmit, screenTexts, payLabel,
  PAY_ACTION, MONEY_ACTION, CREDENTIAL_FIELD, BROWSERS, OTP_SCREEN,
  PAYMENT_PKGS, SYSTEM_PKGS, SETTINGS_PKGS, MESSAGING_PKGS, HANDOFF_TEXT,
  isSystemPkg,
};
