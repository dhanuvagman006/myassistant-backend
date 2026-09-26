/**
 * VIDEO NOTES — the part that moves: storing the owner's finished clip,
 * delivering it, failing or cancelling a note, and the retention sweep.
 * (The rows are in videonotes/store.js, the bytes behind storage/media.js.)
 *
 * Before any clip is stored the owner confirms, per note, that he watched
 * the sender's video and it is the account holder reading the consent
 * sentence (confirmIdentity) — the one check the server cannot make from
 * the bytes. The sender's consent is read again when the clip is stored
 * and again when it is delivered.
 *
 * Delivery happens the moment the owner uploads the clip in the admin
 * panel — there is no second approval step:
 *
 *   recipient is a verified app user  → the clip is copied into THEIR
 *     documents (the same way send_document hands over a file), an
 *     agent_messages row from the sender carries it, and the push says
 *     avatar:'1' so the app opens its video popup. The popup and the
 *     inbox row both say it was made by AI.
 *   recipient is not on the app       → nothing can reach them from here
 *     (no server-side WhatsApp or SMS with media), so the clip goes to the
 *     SENDER's documents with a push saying it is ready to share.
 *
 * Every step reports honestly to task_outcomes, so "did my video note
 * reach Danush?" gets the same answer from every part of the assistant.
 */
const { one, query } = require("../db");
const media = require("../storage/media");
const store = require("./store");

// Kept after delivery so a lost or disputed note can be looked at again;
// the recipient's own copy lives in their documents regardless.
const KEEP_DAYS = (() => {
  const n = Number(process.env.VIDEO_NOTE_KEEP_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 30;
})();

// One key PER UPLOAD. With one fixed name, an upload that lost a race
// deleted the clip the winner had just delivered, and was told "the
// sender cancelled" about a note that had gone out (review, 2026-09-26).
const outputKey = (id, tag = media.newId()) => `renders/${Number(id)}/output-${tag}.mp4`;
const externalId = (id) => `video_note:${Number(id)}`;

const httpError = (http, message) => Object.assign(new Error(message), { http });

/**
 * Why a note cannot move on, in the words the admin page shows. Built
 * from the note's state as it is NOW, never assumed: "already delivered"
 * and "the sender withdrew consent" call for different things.
 */
function whyNot(reason, row) {
  switch (reason) {
    case "missing": return httpError(404, "no such video note");
    case "delivered": return httpError(409, "this video note was already delivered");
    case "cancelled":
      return httpError(409, `this video note was cancelled${row?.error ? ` (${row.error})` : ""} — it will not be delivered`);
    case "withdrawn":
      return httpError(409, "the sender withdrew consent — this video note is cancelled and will not be delivered");
    case "off":
      return httpError(409, "the sender has switched video notes off — it can't go out unless they switch it back on");
    case "unchecked":
      return httpError(409, "watch the sender's video first and confirm it is them reading the consent sentence");
    case "no_video": return httpError(410, "the sender's video is gone (deleted by them)");
    default: return httpError(409, `this video note is ${reason}`);
  }
}

/**
 * A refusal from the store, acted on: when consent is gone, every note of
 * that sender still waiting is cancelled on the spot (and its clips go),
 * so the admin queue stops offering them.
 */
async function refused(got) {
  if (got.refused === "withdrawn" && got.row) {
    await cancelForUser(got.row.user_id, "consent withdrawn").catch((e) =>
      console.warn("video note cancel after withdrawal:", e.message));
  }
  return whyNot(got.refused, got.row);
}

async function userRow(id) {
  if (!id) return null;
  return one(`SELECT id, name, phone_number, fcm_token FROM users WHERE id = $1`, [id]);
}

/** A push that must not fail anything around it. */
async function tell(userId, fcmToken, title, body, data, { queue = false } = {}) {
  try {
    const r = await require("../services/push").send(fcmToken, title, body, data);
    if (r.ok) return true;
    // A device that is unreachable right now gets it on its next open.
    if (queue && !r.stale) {
      await require("../services/pendingPush").queue(userId, title, body, data).catch(() => {});
    }
  } catch (e) {
    console.warn("video note push:", e.message);
  }
  return false;
}

function outcome(render, status, detail) {
  return require("../outcomes/store")
    .updateByExternalId(externalId(render.id), { status, detail })
    .catch((e) => console.warn("video note outcome:", e.message));
}

const firstName = (s) => String(s || "").trim().split(/\s+/)[0] || "Someone";

/**
 * What stands between this note and a clip, checked without writing
 * anything: the note's state, the sender's consent NOW, and the owner's
 * look at the take. The store checks all three again under lock.
 */
async function precheck(r, from) {
  if (!r) return { refused: "missing" };
  if (!from.includes(r.status)) return { refused: r.status, row: r };
  const gate = store.senderGate(await store.getProfile(r.user_id));
  if (gate !== "ok") return { refused: gate, row: r };
  return null;
}

/**
 * Whether a clip may be stored for this note right now; the row, or the
 * reason why not (thrown). The admin upload asks this BEFORE 300 MB
 * crosses the wire, and storeOutput asks again once it has.
 */
async function canStore(id) {
  const r = await store.getRender(id);
  const early = await precheck(r, store.UNDELIVERED);
  if (early) throw await refused(early);
  if (!r.identity_checked_at || r.identity_checked_key !== r.source_video_key) {
    throw whyNot("unchecked", r);
  }
  return r;
}

/**
 * Stores the owner's finished clip for this note (moved in from the
 * upload's temp file) and marks it generated. Refused — and nothing kept
 * — for a note that was cancelled or already delivered, whose sender
 * withdrew consent or switched notes off, or whose take the owner has not
 * confirmed is them. A 'failed' note can be uploaded again, which is why
 * a withdrawal now cancels failed notes too.
 */
async function storeOutput(id, tmpPath) {
  const r = await canStore(id);
  const key = outputKey(r.id);
  const put = await media.put(key, { path: tmpPath });
  let got;
  try {
    got = await store.attachOutput(r.id, key, put.bytes);
  } catch (e) {
    await media.delete(key).catch(() => {});
    throw e;
  }
  if (got.refused) {
    // Only THIS upload's file: another upload may have won and delivered.
    await media.delete(key).catch(() => {});
    throw await refused(got);
  }
  if (got.prevKey && got.prevKey !== key && media.isKey(got.prevKey)) {
    await media.delete(got.prevKey).catch(() => {});
  }
  return got.row;
}

/**
 * The owner's checkpoint: he watched the sender's video and it is the
 * account holder reading the consent sentence. Recorded on the note and
 * in the sender's own activity log, where they can see it.
 */
async function confirmIdentity(id) {
  const got = await store.markIdentityChecked(id);
  if (got.refused) throw await refused(got);
  const r = got.row;
  const tp = store.teleprompter(r.script_version);
  require("../audit/log")
    .record(r.user_id, "video_note.identity_checked",
      `video note #${r.id}: the recorded video was checked — it is you, reading the consent sentence` +
        (tp ? ` (script v${r.script_version})` : ""))
    .catch(() => {});
  return r;
}

/**
 * Delivers a generated note. Returns the updated row. On a failure the
 * note stays 'generated' with the reason in `error`, so the admin page can
 * offer Retry delivery without the owner making the clip again.
 *
 * The copy and the inbox row are made first and the note is marked
 * delivered in ONE locked step that reads the sender's consent again; if
 * they withdrew it or cancelled in the meantime, both are taken back and
 * nothing is announced. Consent is checked HERE and not only when the
 * note was asked for: a failed note uploaded again after a withdrawal
 * reached the recipient before this (review, 2026-09-26).
 */
async function deliver(id) {
  const r = await store.getRender(id);
  const early = await precheck(r, ["generated"]);
  if (early) throw await refused(early);
  if (!r.output_key) throw httpError(409, "no clip is stored for this video note — upload it first");
  const docs = require("../docs/store");
  const made = { docOwner: null, docId: null, messageId: null };
  const undo = async () => {
    if (made.messageId) {
      await query(`DELETE FROM agent_messages WHERE id = $1`, [made.messageId]).catch(() => {});
    }
    if (made.docId) await docs.deleteDocument(made.docOwner, made.docId).catch(() => {});
  };
  try {
    const sender = await userRow(r.user_id);
    if (!sender) throw new Error("the sender's account no longer exists");
    const senderName = sender.name || "Someone";
    const script = String(r.script || "");
    const day = new Date().toISOString().slice(0, 10);
    const name = r.recipient_name || "them";

    // The recipient as of NOW, and only if it is the same person who held
    // the number when the note was asked for.
    let to = r.recipient_phone
      ? await one(
          `SELECT id, name, fcm_token FROM users
            WHERE phone_number = $1 AND phone_verified_at IS NOT NULL LIMIT 1`,
          [r.recipient_phone])
      : null;
    if (to && r.recipient_user_id && Number(to.id) !== Number(r.recipient_user_id)) to = null;

    let done;
    if (to) {
      // THE LABEL IS PART OF THE MESSAGE. Everywhere the recipient meets
      // this clip — the popup, the chat, their documents, the brief — it
      // says an AI made it from the sender's recorded video.
      const label = `AI video note from ${senderName}`;
      const doc = await docs.createDocumentFromStream(to.id, {
        stream: media.stream(r.output_key),
        filename: `video-note-${r.id}.mp4`,
        mime: "video/mp4",
        note: label,
      });
      Object.assign(made, { docOwner: to.id, docId: doc.id });
      // Title AND full text, always: GET /docs re-reads (whole, into
      // memory) any document missing either, to analyse it again.
      await docs.setMetadata(to.id, doc.id, {
        title: label,
        category: "other",
        docDate: day,
        summary: `${label}, made by AI from ${firstName(senderName)}'s recorded video: "${script}"`,
        tags: ["video note", "ai-generated", "video"],
        fullText: `${label}. Made by AI from their recorded video. Script: ${script}`,
      });
      const msg = await one(
        `INSERT INTO agent_messages
           (from_user_id, to_phone_number, message, document_id, media, created_at)
         VALUES ($1,$2,$3,$4,'video',$5) RETURNING id`,
        [r.user_id, r.recipient_phone, `${label}: ${script}`, doc.id, Date.now()]
      );
      made.messageId = msg.id;
      const muted = await require("../routes/chat").mutedBy(to.id, r.user_id).catch(() => false);
      done = await finish(r.id, {
        delivered_at: Date.now(), delivered_to: "recipient",
        document_id: doc.id, message_id: msg.id, error: "",
        note: muted ? "in their app (they muted this chat, so no notification)" : "in their app",
      });
      if (!muted) {
        // avatar:'1' is what makes the app fetch the inbox and open the
        // video popup (push_service.dart _deliver); kind stays
        // agent_message so older handling still applies.
        await tell(to.id, to.fcm_token,
          `${senderName} sent you a video note`,
          "Tap to watch. It was made by AI from their recorded video.",
          { kind: "agent_message", avatar: "1" },
          { queue: true });
      }
      await tell(sender.id, sender.fcm_token, "Your video note was delivered",
        `Your video note reached ${name}.`, { kind: "video_note" });
      await outcome(done, "completed", `reached ${name} in the app`);
    } else {
      // Not on the app (or the number changed hands): the sender shares it.
      const doc = await docs.createDocumentFromStream(sender.id, {
        stream: media.stream(r.output_key),
        filename: `video-note-${r.id}.mp4`,
        mime: "video/mp4",
        note: `video note for ${name}`,
      });
      Object.assign(made, { docOwner: sender.id, docId: doc.id });
      await docs.setMetadata(sender.id, doc.id, {
        title: `Video note for ${name}`,
        category: "other",
        docDate: day,
        summary: `AI video note for ${name}, made from your recorded video: "${script}"`,
        tags: ["video note", "ai-generated", "video"],
        fullText: `AI video note for ${name}. Script: ${script}`,
      });
      done = await finish(r.id, {
        delivered_at: Date.now(), delivered_to: "sender", document_id: doc.id, error: "",
        note: `${r.recipient_name || "They"} isn't on the app — saved to the sender's documents to share`,
      });
      await tell(sender.id, sender.fcm_token, "Your video note is ready",
        `Your video note for ${name} is ready to share — it's in your documents.`,
        { kind: "video_note" }, { queue: true });
      await outcome(done, "completed",
        `ready in your documents to share with ${name} — they aren't on the app`);
    }
    require("../audit/log")
      .record(done.user_id, "video_note.delivered", `video note #${done.id} (${done.delivered_to})`)
      .catch(() => {});
    return done;
  } catch (e) {
    await undo();
    if (e.http) throw e;
    console.error(`video note #${r.id} delivery failed:`, e.message);
    await store.updateRender(r.id, { error: `delivery failed: ${String(e.message).slice(0, 200)}` })
      .catch(() => {});
    throw Object.assign(new Error(`delivery failed: ${e.message}`), { http: 500 });
  }
}

/** generated → delivered, or the reason it cannot be (thrown; deliver undoes). */
async function finish(id, patch) {
  const got = await store.finishDelivery(id, patch);
  if (got.refused) throw await refused(got);
  return got.row;
}

/** The owner could not make it. The sender is told, in one line. */
async function fail(id, reason) {
  const why = String(reason || "").trim().slice(0, 300) || "it could not be made";
  const r = await store.transition(id, ["pending", "generated"], "failed", { error: why });
  if (!r) {
    const cur = await store.getRender(id);
    if (!cur) throw Object.assign(new Error("no such video note"), { http: 404 });
    throw Object.assign(new Error(`this video note is already ${cur.status}`), { http: 409 });
  }
  const sender = await userRow(r.user_id);
  if (sender) {
    await tell(sender.id, sender.fcm_token, "Your video note couldn't be made",
      `Your video note for ${r.recipient_name || "your contact"} couldn't be made. You can ask for it again.`,
      { kind: "video_note" }, { queue: true });
  }
  await outcome(r, "failed", `the video note for ${r.recipient_name || "them"} couldn't be made`);
  return r;
}

/**
 * Stops every note of this sender that has not gone out yet — failed ones
 * included (consent withdrawn, identity deleted) — and removes any clip of
 * theirs still kept for one. Returns how many were cancelled.
 */
async function cancelForUser(userId, reason) {
  const rows = await store.cancelOpen(userId, reason);
  for (const r of rows) {
    // The whole folder: every upload has its own key.
    await media.deletePrefix(`renders/${Number(r.id)}/`).catch(() => {});
    if (r.output_key) {
      await store.updateRender(r.id, { output_key: "", output_bytes: 0 }).catch(() => {});
    }
    await outcome(r, "cancelled", `the video note for ${r.recipient_name || "them"} was cancelled`);
  }
  return rows.length;
}

/**
 * Removes this sender's kept clips (the admin copies, not the delivered
 * documents — a received note belongs to whoever received it, like any
 * message). Used by "Delete everything".
 */
async function deleteOutputsFor(userId) {
  const rows = await query(
    `SELECT id FROM avatar_renders WHERE user_id = $1 AND output_key <> ''`, [userId]);
  let n = 0;
  for (const r of rows) {
    n += await media.deletePrefix(`renders/${Number(r.id)}/`).catch(() => 0);
  }
  if (rows.length) {
    await query(
      `UPDATE avatar_renders SET output_key = '', output_bytes = 0, updated_at = $2
        WHERE user_id = $1 AND output_key <> ''`, [userId, Date.now()]);
  }
  return n;
}

/**
 * RETENTION. The identity video stays until the user deletes it. A made
 * clip is kept KEEP_DAYS after it went out (or after it failed or was
 * cancelled), then only the delivered copy in documents remains. Runs
 * with the daily recordings sweep in server.js.
 */
async function sweep() {
  const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
  const rows = await query(
    `SELECT id, output_key FROM avatar_renders
      WHERE output_key <> ''
        AND ((status = 'delivered' AND delivered_at < $1)
          OR (status IN ('failed', 'cancelled') AND updated_at < $1))`,
    [cutoff]
  );
  let removed = 0;
  for (const r of rows) {
    removed += await media.deletePrefix(`renders/${Number(r.id)}/`).catch(() => 0);
    await query(
      `UPDATE avatar_renders SET output_key = '', output_bytes = 0 WHERE id = $1`, [r.id]);
  }
  if (removed) console.log(`video notes: ${removed} kept clip(s) older than ${KEEP_DAYS} days removed`);
  return removed;
}

module.exports = {
  canStore, storeOutput, deliver, fail, confirmIdentity, cancelForUser, deleteOutputsFor, sweep,
  outputKey, externalId, KEEP_DAYS,
};
