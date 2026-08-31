/**
 * PUBLIC LEGAL PAGES — no auth, served at:
 *   GET /legal/privacy   Privacy Policy  (the URL Play Store asks for)
 *   GET /legal/terms     Terms & Conditions
 *
 * Content is tailored to what the app ACTUALLY collects (voice, contacts,
 * location, documents, screen-time, finance ledger) and the rights the
 * backend really honours (in-app full export + permanent deletion —
 * routes/privacy.js). Written for the DPDP Act 2023 / IT Rules context;
 * a startup-grade baseline the founder should still have counsel review.
 */
const router = require("express").Router();

const EFFECTIVE = "31 August 2026";
const CONTACT = "myassistant658@gmail.com";
const ENTITY = "Hari Assistant";

function shell(title, body) {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} — ${ENTITY}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  :root { --ink:#101321; --lo:#5a6072; --line:#e7e9f0; --accent:#4f46e5; --bg:#fafbfe; }
  * { box-sizing:border-box; margin:0; }
  body { font-family:'Inter',system-ui,sans-serif; background:var(--bg); color:var(--ink); line-height:1.65; }
  .wrap { max-width:760px; margin:0 auto; padding:48px 24px 96px; }
  header.doc { border-bottom:1px solid var(--line); padding-bottom:24px; margin-bottom:36px; }
  .brand { font-weight:800; font-size:14px; letter-spacing:0.08em; text-transform:uppercase; color:var(--accent); }
  h1 { font-size:32px; font-weight:800; letter-spacing:-0.02em; margin:10px 0 6px; }
  .meta { color:var(--lo); font-size:13.5px; }
  h2 { font-size:19px; font-weight:700; margin:36px 0 10px; letter-spacing:-0.01em; }
  h3 { font-size:15.5px; font-weight:600; margin:20px 0 6px; }
  p, li { font-size:15px; color:#2a2f3f; }
  ul { padding-left:22px; margin:8px 0 14px; }
  li { margin-bottom:6px; }
  table { width:100%; border-collapse:collapse; margin:12px 0 18px; font-size:14px; }
  th, td { text-align:left; padding:9px 12px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--lo); font-weight:600; font-size:12.5px; text-transform:uppercase; letter-spacing:0.04em; }
  .note { background:#eef0fb; border-left:3px solid var(--accent); border-radius:0 8px 8px 0; padding:12px 16px; font-size:14px; margin:16px 0; }
  a { color:var(--accent); }
  footer { margin-top:56px; border-top:1px solid var(--line); padding-top:20px; color:var(--lo); font-size:13px; }
  nav.tabs { display:flex; gap:18px; margin-top:14px; font-size:13.5px; }
</style></head>
<body><div class="wrap">
<header class="doc">
  <div class="brand">${ENTITY}</div>
  <h1>${title}</h1>
  <div class="meta">Effective: ${EFFECTIVE} · Contact: <a href="mailto:${CONTACT}">${CONTACT}</a></div>
  <nav class="tabs"><a href="/legal/privacy">Privacy Policy</a><a href="/legal/terms">Terms &amp; Conditions</a></nav>
</header>
${body}
<footer>© ${new Date().getFullYear()} ${ENTITY}. Questions or requests: <a href="mailto:${CONTACT}">${CONTACT}</a>.</footer>
</div></body></html>`;
}

const PRIVACY = `
<p>${ENTITY} ("Hari", "we") is a personal AI voice assistant. This policy explains exactly what data the app collects, why, where it goes, and the controls you have. We built the product so that <strong>everything we hold about you is visible to you and deletable by you, in the app, without asking us</strong>.</p>

<h2>1. What we collect, and why</h2>
<table>
<tr><th>Data</th><th>Why we collect it</th></tr>
<tr><td>Account details — name, email, sign-in provider, verified phone number</td><td>To create your account, secure it, and let other Hari users' assistants deliver messages to you by your number.</td></tr>
<tr><td>Voice audio and transcripts</td><td>To understand and answer you. Audio is processed in real time and is not kept as recordings; transcripts of a session are used to run that conversation.</td></tr>
<tr><td>Contacts you interact with</td><td>Contact search runs on your phone. A contact's name/number reaches our servers only when needed to complete an action you asked for (a call, a message, adding someone to your circle).</td></tr>
<tr><td>Location (approximate, optional)</td><td>Weather, nearby places, cab pickups. Collected only after you grant the Android permission; deny it and these features simply ask you for a city.</td></tr>
<tr><td>Documents and photos you save</td><td>Only files you explicitly ask Hari to save ("scan this", "remember this receipt") are stored, so you can recall and share them later.</td></tr>
<tr><td>App-usage / screen-time statistics (optional)</td><td>Only if you enable Android's Usage Access for Hari, so you can ask about and reduce your screen time.</td></tr>
<tr><td>Finance items you enter</td><td>EMIs, incomes and expenses you type or dictate, so Hari can help you plan. We never connect to your bank and never see account credentials.</td></tr>
<tr><td>Reminders, promises, personal facts, agent messages</td><td>The assistant's memory of what you asked it to remember and deliver.</td></tr>
<tr><td>Device push token</td><td>To deliver notifications (e.g. a message from a family member's assistant).</td></tr>
</table>

<h2>2. What we do NOT do</h2>
<ul>
<li>We do not sell or rent your personal data to anyone.</li>
<li>We do not show advertising and do not share data with advertisers or data brokers.</li>
<li>We do not read your contacts, messages, files or location in the background — data flows only when a feature you invoked needs it.</li>
<li>We do not store your voice as audio recordings.</li>
</ul>

<h2>3. Processors we rely on</h2>
<p>Hari uses a small number of service providers to function. They receive only what the feature requires, and only to provide the service to you:</p>
<table>
<tr><th>Provider</th><th>Used for</th></tr>
<tr><td>Google (Gemini AI, Firebase Authentication, Cloud Messaging)</td><td>Understanding and answering your requests; sign-in; push notifications. Voice/text sent for AI processing is handled under Google's API data-use terms.</td></tr>
<tr><td>Telephony provider (Exotel)</td><td>Placing assistant-relayed phone calls you request.</td></tr>
<tr><td>Market/news/image services (Yahoo Finance, Google News, image-generation providers)</td><td>Live market data, headlines, and images you ask Hari to create. Only your query content is sent — never your identity.</td></tr>
</table>

<h2>4. Storage and security</h2>
<p>Your data is stored on our servers in an access-controlled database, with transport encryption (HTTPS/TLS) for everything in transit, per-user isolation for all records, and authentication on every API. Backups run nightly and are covered by the same deletion guarantees.</p>

<h2>5. Retention</h2>
<p>We keep your data for as long as your account exists, because the product's purpose is to remember for you. Assistant memory is capped and self-prunes. Delete an item (a document, a memory, a finance entry) and it is removed immediately; delete your account and everything goes with it.</p>

<h2>6. Your rights and controls</h2>
<ul>
<li><strong>Export</strong> — the app's privacy screen gives you a one-tap download of everything we hold about you, as a single file.</li>
<li><strong>Delete</strong> — the app's privacy screen permanently erases your account: database records, saved documents and files, in one irreversible action.</li>
<li><strong>Correct / forget</strong> — tell Hari "forget that" or edit items directly; memories, reminders, documents and finance items are all user-editable.</li>
<li><strong>Permissions</strong> — microphone, contacts, location and usage access are all individually revocable in Android settings; the app degrades gracefully without them.</li>
</ul>
<p>You can also exercise any of these rights, or raise a grievance under India's Digital Personal Data Protection Act, 2023, by writing to <a href="mailto:${CONTACT}">${CONTACT}</a>. We respond within 30 days.</p>

<h2>7. Children</h2>
<p>Hari is not directed at children under 13, and we do not knowingly collect their data. If you believe a child is using the app, contact us and we will delete the account.</p>

<h2>8. Changes</h2>
<p>If this policy changes materially, we will notify you in the app before the change takes effect. The "Effective" date above always reflects the current version.</p>
`;

const TERMS = `
<p>These Terms govern your use of the ${ENTITY} application and services ("Hari"). By creating an account or using the app you agree to them.</p>

<h2>1. The service</h2>
<p>Hari is a personal AI assistant: it answers by voice, places calls and delivers messages on your instruction, saves documents and reminders, tracks screen time you opt into, generates images and written drafts, shows market information, and helps you plan your finances. Features may change, improve or be withdrawn as the product evolves.</p>

<h2>2. Your account</h2>
<ul>
<li>You must be at least 13 years old (and at least 18 to use finance-planning features).</li>
<li>You are responsible for your device and for keeping your sign-in secure.</li>
<li>One verified phone number belongs to one account; verifying a number you do not own is prohibited.</li>
</ul>

<h2>3. AI output — important</h2>
<div class="note">Hari's answers are generated by artificial intelligence and <strong>can be wrong, incomplete or outdated</strong>. They are provided for information and convenience only.</div>
<ul>
<li><strong>Not professional advice.</strong> Nothing Hari says is medical, legal, tax or investment advice. Market data and buy/avoid ideas in the Stocks Hub are informational; finance planning is arithmetic on numbers you entered. Consult a qualified professional before acting on anything significant.</li>
<li><strong>Verify before you rely.</strong> For anything important — a dosage, a legal deadline, a payment — check the primary source.</li>
</ul>

<h2>4. Calls, messages and emergencies</h2>
<ul>
<li>Actions Hari performs on your behalf (calls, messages, agent-to-agent delivery) are made on your instruction and are your responsibility.</li>
<li><strong>Emergency calling is best-effort.</strong> Hari can dial emergency numbers when asked, but a voice assistant is not a guaranteed emergency channel — network, permissions or device state can prevent a call. In a real emergency, dial 112 directly yourself whenever possible.</li>
<li>Assistant-relayed calls use third-party telephony and may be unavailable at times.</li>
</ul>

<h2>5. Acceptable use</h2>
<p>You agree not to use Hari to harass or defraud anyone, to send unlawful communications, to infringe others' rights (including generating unlawful images), to probe or disrupt the service, or to access another person's data. We may suspend accounts that do.</p>

<h2>6. Your content</h2>
<p>Documents, notes, finance entries and other content you save remain yours. You grant us only the licence needed to store and process them to provide the service to you. Images and drafts Hari generates for you are yours to use; you are responsible for how you use them.</p>

<h2>7. Fees</h2>
<p>Core features may be free during the launch period. If paid plans are introduced, pricing and billing terms will be shown in the app before you are charged.</p>

<h2>8. Liability</h2>
<p>The service is provided "as is". To the maximum extent permitted by law, ${ENTITY} is not liable for indirect or consequential losses, or for outcomes of acting on AI-generated output contrary to Section 3. Our total liability for any claim is limited to the amount you paid us in the 12 months before the claim (or ₹1,000 if you paid nothing). Nothing in these terms limits liability that cannot be limited under law.</p>

<h2>9. Termination</h2>
<p>You can delete your account at any time from the privacy screen — that ends these terms and erases your data. We may suspend or terminate accounts for breach of Section 5, with notice where practicable.</p>

<h2>10. Governing law</h2>
<p>These terms are governed by the laws of India; courts at Bengaluru, Karnataka have exclusive jurisdiction.</p>

<h2>11. Contact</h2>
<p>Questions and grievances: <a href="mailto:${CONTACT}">${CONTACT}</a>. Grievances are acknowledged within 48 hours and resolved within 30 days, per applicable Indian IT rules.</p>
`;

router.get("/privacy", (_req, res) => {
  res.setHeader("Content-Security-Policy",
    "default-src 'self'; style-src 'unsafe-inline' https:; font-src https: data:;");
  res.send(shell("Privacy Policy", PRIVACY));
});

router.get("/terms", (_req, res) => {
  res.setHeader("Content-Security-Policy",
    "default-src 'self'; style-src 'unsafe-inline' https:; font-src https: data:;");
  res.send(shell("Terms & Conditions", TERMS));
});

router.get("/", (_req, res) => res.redirect("/legal/privacy"));

module.exports = router;
