/**
 * NEW FEATURES, 2026-09-23 — `npm run test:features`.
 *
 * Document expiry alerts, follow-ups after calls, pay by voice (UPI),
 * smart email replies, MCP reconnect after a restart, and the astrology
 * key out of the source. Gemini and mail are stubbed: nothing here pays
 * for a token or sends a real email.
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://myassistant:localdev@localhost:5432/myassistant";
process.env.NODE_ENV = process.env.NODE_ENV || "test";

const assert = require("assert");
const fs = require("fs");
const express = require("express");
const db = require("../src/db");

let passed = 0;
async function atest(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.stack || e.message}`); process.exitCode = 1; }
}
const src = (f) => fs.readFileSync(__dirname + "/../src/" + f, "utf8");

(async () => {
  await db.init();
  const registry = require("../src/tools/registry");
  require("../src/tools/builtins").registerBuiltins();
  const user = await db.createUser({
    email: `features-${Date.now()}@example.test`, name: "Dhanush K", gender: "male",
  });
  const UID = user.id;
  await db.run(`UPDATE users SET tz_offset_min=330 WHERE id=$1`, [UID]);
  const ctx = { userId: UID, source: "text" };

  try {
    console.log("\ndocument expiry alerts");
    const expiry = require("../src/docs/expiry");

    await atest("the renewal alert lands at 10 am the user's time", () => {
      // 10:00 IST on 1 Nov 2026 is 04:30 UTC.
      assert.strictEqual(new Date(expiry.alertAt("2026-11-01", 0, 330)).toISOString(),
        "2026-11-01T04:30:00.000Z");
      assert.strictEqual(new Date(expiry.alertAt("2026-11-01", 30, 330)).toISOString(),
        "2026-10-02T04:30:00.000Z");
      assert.strictEqual(expiry.cleanDate("31/12/2026"), "");
      assert.strictEqual(expiry.cleanDate("2026-12-31"), "2026-12-31");
    });

    await atest("a scanned policy files 30-day, 7-day and same-day reminders, once", async () => {
      const doc = await db.one(
        `INSERT INTO documents (user_id, filename, mime, size, path, title, category, created_at)
         VALUES ($1,'policy.pdf','application/pdf',10,'','Car insurance — ACKO','other',$2)
         RETURNING id`, [UID, Date.now()]);
      const future = new Date(Date.now() + 60 * 864e5).toISOString().slice(0, 10);
      const filed = await expiry.onExpiry(UID, doc.id, future);
      assert.strictEqual(filed, 3);
      const rem = await db.query(
        `SELECT text FROM reminders WHERE user_id=$1 ORDER BY due_at`, [UID]);
      assert.strictEqual(rem.length, 3);
      assert.match(rem[0].text, /Car insurance — ACKO expires on .* time to renew/);
      assert.match(rem[2].text, /expires today/);
      assert.strictEqual(await expiry.onExpiry(UID, doc.id, future), 0,
        "re-analysis must not file them again");
      const list = await expiry.listExpiring(UID);
      assert.strictEqual(list[0].daysLeft, 60);
      assert.strictEqual(list[0].expired, false);
    });

    await atest("an already-expired ID files nothing but is still listed as expired", async () => {
      const doc = await db.one(
        `INSERT INTO documents (user_id, filename, mime, size, path, title, category, created_at)
         VALUES ($1,'dl.jpg','image/jpeg',10,'','Driving licence','id',$2) RETURNING id`,
        [UID, Date.now()]);
      assert.strictEqual(await expiry.onExpiry(UID, doc.id, "2020-01-01"), 0);
      const r = await registry.get("list_expiring_documents").execute({}, ctx);
      const dl = r.data.documents.find((d) => d.title === "Driving licence");
      assert.ok(dl && dl.expired);
    });

    await atest("the analyser asks for the expiry and the app is sent it", () => {
      assert.match(src("docs/analyze.js"), /"expires_on":/);
      assert.match(src("docs/store.js"), /expiresOn: d\.expires_on/);
      assert.match(src("routes/docs.js"), /docs\/expiry"\)\.onExpiry/);
    });

    console.log("\npay by voice (UPI)");
    const pay = registry.get("pay_by_upi");

    await atest("no saved UPI ID: the tool asks for it instead of guessing", async () => {
      const r = await pay.execute({ payee: "Ravi", amount: 500 }, ctx);
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.error, "need_upi_id");
      assert.ok(!r.deviceAction, "nothing opens without a payee address");
    });

    await atest("with the ID: the UPI app opens prefilled, and the ID is remembered", async () => {
      const r = await pay.execute(
        { payee: "Ravi", amount: 500, note: "lunch", upi_id: "Ravi@OKAXIS" }, ctx);
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.deviceAction.type, "open_url");
      assert.strictEqual(r.deviceAction.url,
        "upi://pay?pa=ravi@okaxis&pn=Ravi&am=500.00&cu=INR&tn=lunch");
      assert.match(r.speak, /approve with your PIN/);
      assert.doesNotMatch(r.speak, /\bpaid\b/i, "the assistant never moves money");
      const again = await pay.execute({ payee: "ravi", amount: 250.5 }, ctx);
      assert.match(again.deviceAction.url, /pa=ravi@okaxis&pn=ravi&am=250\.50/);
    });

    await atest("junk IDs and impossible amounts are refused", async () => {
      assert.match((await pay.execute({ payee: "X", amount: 10, upi_id: "not an id" }, ctx)).error,
        /not a valid UPI ID/);
      assert.match((await pay.execute({ payee: "Ravi", amount: 0 }, ctx)).error, /between/);
      assert.match((await pay.execute({ payee: "Ravi", amount: 200000 }, ctx)).error, /between/);
    });

    await atest("save_upi_id stores it for the next payment", async () => {
      const r = await registry.get("save_upi_id").execute(
        { person: "Amma", upi_id: "9876543210@ybl" }, ctx);
      assert.strictEqual(r.ok, true);
      const p = await pay.execute({ payee: "Amma", amount: 100 }, ctx);
      assert.match(p.deviceAction.url, /pa=9876543210@ybl/);
    });

    await atest("money is guarded: never unattended, confirmed after untrusted content", () => {
      assert.ok(registry.EFFECTIVE.unattendedBlocked.has("pay_by_upi"));
      // After an email or web page was read, paying, replying or saving a
      // UPI ID needs the user's explicit yes (prompt injection).
      const clean = { userId: UID };
      const tainted = { userId: UID, __untrustedAt: Date.now() };
      for (const t of ["pay_by_upi", "save_upi_id"]) {
        assert.strictEqual(registry.requiresConfirmation(t, clean), false, `${t} flows normally`);
        assert.strictEqual(registry.requiresConfirmation(t, tainted), true, `${t} after untrusted content`);
      }
      assert.strictEqual(registry.requiresConfirmation("email_reply", clean), true);
    });

    console.log("\nsmart email replies");
    const email = require("../src/services/email");
    const realFind = email.findForReply, realSend = email.send, realRec = email.recordSent;
    const sent = [];
    email.findForReply = async (_uid, q) => (q.from === "Ramesh"
      ? { uid: "m1", to: "ramesh@corp.test", toName: "Ramesh", subject: "Re: Friday review",
          inReplyTo: "<abc@corp.test>", threadId: "t-9" }
      : null);
    email.send = async (_uid, m) => { sent.push(m); return { messageId: "x1" }; };
    email.recordSent = async () => {};
    try {
      await atest("a reply goes to the same thread, the right address, with Re:", async () => {
        const r = await registry.get("email_reply").execute(
          { from: "Ramesh", body: "Friday works. — Dhanush" }, ctx);
        assert.strictEqual(r.ok, true);
        assert.deepStrictEqual(sent[0], {
          to: "ramesh@corp.test", subject: "Re: Friday review", body: "Friday works. — Dhanush",
          inReplyTo: "<abc@corp.test>", threadId: "t-9",
        });
        assert.match(r.speak, /Replied to Ramesh/);
      });
      await atest("no matching email: it says so and sends nothing", async () => {
        const n = sent.length;
        const r = await registry.get("email_reply").execute({ from: "Nobody", body: "hi" }, ctx);
        assert.strictEqual(r.ok, false);
        assert.match(r.error, /email_read/);
        assert.strictEqual(sent.length, n);
      });
    } finally {
      email.findForReply = realFind; email.send = realSend; email.recordSent = realRec;
    }

    await atest("a reply is always confirmed first", () => {
      assert.strictEqual(registry.get("email_reply").risk, "high");
    });

    await atest("'Sent, your mail is on its way' after a real send is not called a lie", () => {
      const cc = require("../src/agents/claimCheck");
      assert.strictEqual(cc.check("Sent, your mail is on its way.",
        [{ tool: "email_send", ok: true }]).ok, true);
      assert.strictEqual(cc.check("Replied — it's sent.",
        [{ tool: "email_reply", ok: true }]).ok, true);
      assert.strictEqual(cc.check("Opening your UPI app now.",
        [{ tool: "pay_by_upi", ok: true }]).ok, true);
    });

    await atest("Gmail replies carry the thread; SMTP replies carry In-Reply-To", () => {
      assert.match(src("google/api.js"), /if \(threadId\) payload\.threadId = threadId;/);
      assert.match(src("services/email.js"), /inReplyTo, references: inReplyTo/);
    });

    console.log("\nfollow-ups after calls");
    const ai = require("../src/services/ai/router");
    const realGen = ai.generateReply;
    let calls = 0;
    ai.generateReply = async () => { calls++; return { reply: '{"follow_up":"Thanks Manish — see you Friday at 10."}' }; };
    const app = express();
    app.use((req, _res, next) => { req.user = { sub: String(UID) }; next(); });
    app.use("/calls", require("../src/routes/calls").router);
    const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}/calls`;
    try {
      const rec = await db.one(
        `INSERT INTO call_records (user_id, peer_name, started_at, summary, facts, status)
         VALUES ($1,'Manish',$2,'Agreed to meet on Friday at 10.','["Meeting Friday 10 am"]','done')
         RETURNING id`, [UID, Date.now()]);

      await atest("an older call gets its follow-up drafted once, then it is kept", async () => {
        const a = await (await fetch(`${base}/${rec.id}/follow-up`, { method: "POST" })).json();
        assert.strictEqual(a.followUp, "Thanks Manish — see you Friday at 10.");
        const b = await (await fetch(`${base}/${rec.id}/follow-up`, { method: "POST" })).json();
        assert.strictEqual(b.followUp, a.followUp);
        assert.strictEqual(calls, 1, "paid for once");
        const d = await (await fetch(`${base}/${rec.id}`)).json();
        assert.strictEqual(d.call.follow_up, a.followUp);
      });

      await atest("someone else's call is not theirs to draft", async () => {
        const other = await db.one(
          `INSERT INTO call_records (user_id, peer_name, started_at, summary, status)
           VALUES ($1,'X',$2,'s','done') RETURNING id`, [UID + 100000, Date.now()]);
        const r = await fetch(`${base}/${other.id}/follow-up`, { method: "POST" });
        assert.strictEqual(r.status, 404);
        await db.run(`DELETE FROM call_records WHERE id=$1`, [other.id]);
      });

      await atest("new analyses draft the follow-up in the same pass", () => {
        const s = src("routes/calls.js");
        assert.match(s, /"follow_up":"\$\{FOLLOW_UP_SPEC\}"/);
        assert.match(s, /follow_up=\$5/);
      });
    } finally {
      ai.generateReply = realGen;
      server.close();
    }

    console.log("\ndocuments shared in, and what recall shows (2026-09-27)");
    const dapp = express();
    dapp.use((req, _res, next) => { req.user = { sub: String(UID) }; next(); });
    dapp.use("/docs", require("../src/routes/docs"));
    const dserver = await new Promise((r) => { const s = dapp.listen(0, "127.0.0.1", () => r(s)); });
    const dbase = `http://127.0.0.1:${dserver.address().port}/docs`;
    const upload = (mime, name) => {
      const fd = new FormData();
      fd.append("file", new Blob([Buffer.alloc(2048, 7)], { type: mime }), name);
      return fetch(dbase, { method: "POST", body: fd });
    };
    // No key: nothing uploaded here may reach a real model.
    const keys = { GEMINI_API_KEY: process.env.GEMINI_API_KEY, GEMINI_FALLBACK_KEYS: process.env.GEMINI_FALLBACK_KEYS };
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_FALLBACK_KEYS;
    const saved = [];
    try {
      await atest("an old .xls is kept, not read — and the reply says so in words", async () => {
        const r = await upload("application/vnd.ms-excel", "Accounts 2019.xls");
        assert.strictEqual(r.status, 200);
        const j = await r.json();
        saved.push(j.document.id);
        assert.strictEqual(j.readable, false);
        assert.match(j.notice, /can't read inside old Excel files/);
        assert.match(j.document.title, /^Document · /, "a spreadsheet is not called a Photo");
        const row = await db.one(`SELECT path FROM documents WHERE id=$1`, [j.document.id]);
        assert.match(row.path, /\.xls$/, "saved with the extension a viewer opens");
      });

      await atest("a HEIC photo is read like any photo; a zip is refused in a sentence the app shows", async () => {
        const h = await upload("image/heic", "IMG_2041.heic");
        assert.strictEqual(h.status, 200);
        const j = await h.json();
        saved.push(j.document.id);
        assert.strictEqual(j.readable, true);
        assert.strictEqual(j.notice, null);
        const z = await upload("application/zip", "x.zip");
        assert.strictEqual(z.status, 415);
        assert.match((await z.json()).error, /^That kind of file can't be saved here .*Photos, PDFs/);
      });

      await atest("'my last hospital report' with none saved: an unread scan may stand in, a filed report may not", async () => {
        const docsStore = require("../src/docs/store");
        const report = await docsStore.createDocument(UID, {
          buffer: Buffer.from("x"), filename: "Q3 Sales Report.pdf", mime: "application/pdf", note: "" });
        await docsStore.setMetadata(UID, report.id, { title: "Q3 Sales Report", category: "other" });
        saved.push(report.id);
        const s = await docsStore.searchDocuments(UID, "show me my last hospital report");
        assert.strictEqual(s.exact, false);
        assert.ok(!s.hits.some((h) => h.id === report.id), "a filed sales report is not a hospital report");
        assert.ok(s.hits.some((h) => h.id === saved[0]), "a save whose kind is unknown still stands in");
        const any = await docsStore.searchDocuments(UID, "show me the document I saved");
        assert.ok(any.hits.some((h) => h.id === report.id), "no kind asked: recent saves as before");
      });
    } finally {
      for (const [k, v] of Object.entries(keys)) if (v !== undefined) process.env[k] = v;
      for (const id of saved) await fetch(`${dbase}/${id}`, { method: "DELETE" }).catch(() => {});
      dserver.close();
    }

    console.log("\nbusiness card scanner");
    const card = require("../src/people/card");

    await atest("a card is read into clean fields", () => {
      const c = card.normalise({
        name: " Priya  Sharma ", title: "Head of Sales", company: "Acme Pvt Ltd",
        phones: ["+91 98450 12345", "080-2345"], emails: ["Priya@Acme.in", "not-an-email"],
      });
      assert.strictEqual(c.name, "Priya Sharma");
      assert.deepStrictEqual(c.phones, ["+919845012345", "0802345"]);
      assert.deepStrictEqual(c.emails, ["priya@acme.in"]);
    });

    const realRead = card.readCard;
    card.readCard = async () => card.normalise({
      name: "Priya Sharma", title: "Head of Sales", company: "Acme Pvt Ltd",
      phones: ["+91 98450 12345"], emails: ["priya@acme.in"], website: "acme.in",
    });
    const capp = express();
    capp.use((req, _res, next) => { req.user = { sub: String(UID) }; next(); });
    capp.use("/clients", require("../src/routes/clients"));
    const cserver = await new Promise((r) => { const s = capp.listen(0, "127.0.0.1", () => r(s)); });
    try {
      await atest("scanning saves the person with phone, email and the card photo", async () => {
        const fd = new FormData();
        fd.append("file", new Blob([Buffer.alloc(2048, 1)], { type: "image/jpeg" }), "card.jpg");
        const r = await fetch(`http://127.0.0.1:${cserver.address().port}/clients/scan-card`,
          { method: "POST", body: fd });
        assert.strictEqual(r.status, 200);
        const { person } = await r.json();
        assert.strictEqual(person.name, "Priya Sharma");
        const row = await db.one(`SELECT phone, email, organisation, relationship FROM clients WHERE id=$1`, [person.id]);
        assert.deepStrictEqual(row, {
          phone: "+919845012345", email: "priya@acme.in",
          organisation: "Acme Pvt Ltd", relationship: "business contact",
        });
        const doc = await db.one(`SELECT title FROM documents WHERE id=$1`, [person.documentId]);
        assert.strictEqual(doc.title, "Business card — Priya Sharma");
      });

      await atest("a photo with no name on it is refused, not saved as nobody", async () => {
        card.readCard = async () => card.normalise({});
        const fd = new FormData();
        fd.append("file", new Blob([Buffer.alloc(2048, 1)], { type: "image/jpeg" }), "x.jpg");
        const r = await fetch(`http://127.0.0.1:${cserver.address().port}/clients/scan-card`,
          { method: "POST", body: fd });
        assert.strictEqual(r.status, 422);
      });
    } finally {
      card.readCard = realRead;
      cserver.close();
    }

    await atest("the camera and the recorder are only offered to apps that have them", () => {
      const names = (build) => registry.declarations({
        userId: UID, deviceCaps: { build, granted: [], denied: [] },
      }).map((d) => d.name);
      assert.ok(!names(102).includes("scan_business_card"));
      assert.ok(!names(102).includes("record_meeting"));
      assert.ok(names(103).includes("scan_business_card"));
      assert.ok(names(103).includes("record_meeting"));
    });

    console.log("\nmeeting recorder → minutes");
    const ai2 = require("../src/services/ai/router");
    const realT = ai2.transcribeAudio, realG = ai2.generateReply;
    ai2.transcribeAudio = async () => ({ text: "Dhanush: let's ship the app on Friday. Ravi: I'll send the invoice by Monday. Dhanush: I'll call the client tomorrow." });
    ai2.generateReply = async () => ({ reply: JSON.stringify({
      summary: "Agreed to ship on Friday.",
      decisions: ["Ship the app on Friday"],
      actions: [
        { text: "Call the client", owner: "Dhanush", when: "tomorrow", mine: true },
        { text: "Send the invoice", owner: "Ravi", when: "Monday", mine: false },
      ],
      follow_up: "Thanks all — shipping Friday.",
    }) });
    const mapp = express();
    mapp.use((req, _res, next) => { req.user = { sub: String(UID), name: "Dhanush K" }; next(); });
    mapp.use("/meetings", require("../src/meetings/routes"));
    const mserver = await new Promise((r) => { const s = mapp.listen(0, "127.0.0.1", () => r(s)); });
    const mbase = `http://127.0.0.1:${mserver.address().port}/meetings`;
    try {
      let id;
      await atest("a recording is accepted at once and shows as processing", async () => {
        const fd = new FormData();
        fd.append("title", "Launch sync");
        fd.append("duration_s", "1800");
        fd.append("audio", new Blob([Buffer.alloc(64 * 1024, 3)]), "meeting.m4a");
        const r = await fetch(`${mbase}/record`, { method: "POST", body: fd });
        assert.strictEqual(r.status, 202);
        id = (await r.json()).id;
        assert.ok(id > 0);
      });

      await atest("the minutes arrive: summary, decisions, and my tasks become promises", async () => {
        let m;
        for (let i = 0; i < 40; i++) {
          m = await (await fetch(`${mbase}/${id}`)).json();
          if (m.status !== "processing") break;
          await new Promise((r) => setTimeout(r, 100));
        }
        assert.strictEqual(m.status, "done");
        assert.strictEqual(m.title, "Launch sync");
        assert.deepStrictEqual(m.decisions, ["Ship the app on Friday"]);
        const promises = await db.query(
          `SELECT text FROM commitments WHERE user_id=$1 AND source='meeting'`, [UID]);
        assert.deepStrictEqual(promises.map((p) => p.text), ["Call the client"],
          "only the user's own actions are tracked");
      });

      await atest("the minutes download as a real PDF", async () => {
        const r = await fetch(`${mbase}/${id}/pdf`);
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.headers.get("content-type"), "application/pdf");
        const b = Buffer.from(await r.arrayBuffer());
        assert.strictEqual(b.subarray(0, 4).toString(), "%PDF");
      });

      await atest("a recording a restart cut short says so instead of spinning forever", async () => {
        const meetings = require("../src/meetings/service");
        const pid = await meetings.createPending(UID, { title: "Cut short" });
        await meetings.recoverInterrupted();
        const m = await meetings.get(UID, pid);
        assert.strictEqual(m.status, "failed");
        assert.match(m.summary, /interrupted/);
      });

      await atest("the old /audio endpoint no longer throws on the transcript", async () => {
        const fd = new FormData();
        fd.append("audio", new Blob([Buffer.alloc(4096, 2)]), "a.m4a");
        const r = await fetch(`${mbase}/audio`, { method: "POST", body: fd });
        assert.strictEqual(r.status, 201);
      });
    } finally {
      ai2.transcribeAudio = realT;
      ai2.generateReply = realG;
      mserver.close();
      await db.run(`DELETE FROM meetings WHERE user_id=$1`, [UID]);
      await db.run(`DELETE FROM commitments WHERE user_id=$1`, [UID]);
    }

    console.log("\nhousekeeping");

    await atest("MCP integrations come back after a restart, once per user", async () => {
      const mcp = require("../src/mcp/routes");
      const a = mcp.ensureConnected(UID);
      assert.strictEqual(mcp.ensureConnected(UID), a, "one reconnect, not one per turn");
      assert.deepStrictEqual(await mcp.ensureConnectedWithin(UID), []);
      assert.match(src("agents/runtime.js"), /ensureConnectedWithin\(ctx\.userId\)/);
      assert.match(src("live/proxy.js"), /ensureConnectedWithin\(uid\)/);
    });

    await atest("no API key is committed in the astrology tool", () => {
      const s = src("services/tools/astrology.js");
      assert.doesNotMatch(s, /["'][A-Za-z0-9]{32,}["']/);
      assert.match(s, /process\.env\.ASTROLOGY_API_KEY \|\| ""/);
    });
  } finally {
    await db.run(`DELETE FROM reminders WHERE user_id=$1`, [UID]);
    await db.run(`DELETE FROM documents WHERE user_id=$1`, [UID]);
    await db.run(`DELETE FROM clients WHERE user_id=$1`, [UID]);
    await db.run(`DELETE FROM call_records WHERE user_id=$1`, [UID]);
    await db.run(`DELETE FROM users WHERE id=$1`, [UID]);
  }
  console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
  process.exit(process.exitCode || 0);
})();
