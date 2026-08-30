/**
 * INBOUND CALLING — schema.
 *
 * The mirror image of agent calls. Outbound, Hari dials on the user's
 * behalf; here she ANSWERS a number that belongs to the user, screens who
 * is calling, takes a message, answers what she can, books an appointment,
 * or forwards the call through to the user when it is someone who matters.
 *
 * This is the part a busy professional actually cannot do themselves: they
 * are in surgery, in court, or in a meeting, and the call still gets
 * answered by someone who knows their diary and their clients.
 *
 * THREE TABLES:
 *   inbound_numbers   which Plivo number belongs to which user. Plivo tells
 *                     us the number that was DIALLED, and that is the only
 *                     way to know whose assistant is answering.
 *   inbound_settings  per-user behaviour: on/off, who gets forwarded, what
 *                     Hari may say, where to forward to.
 *   inbound_calls     the record of every answered call — who called, the
 *                     transcript, what Hari did, and whether the user has
 *                     seen it. This is a call LOG the user owns.
 */

async function migrate(exec) {
  await exec(`
    -- Which of our Plivo numbers answers for which user. One number, one
    -- user: a shared number could not know whose diary to speak from.
    CREATE TABLE IF NOT EXISTS inbound_numbers (
      phone      TEXT PRIMARY KEY,          -- E.164, the number callers dial
      user_id    INTEGER NOT NULL,
      created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_inbound_numbers_user
      ON inbound_numbers(user_id);

    CREATE TABLE IF NOT EXISTS inbound_settings (
      user_id      INTEGER PRIMARY KEY,
      enabled      BOOLEAN NOT NULL DEFAULT TRUE,
      -- screen_all      : everyone talks to Hari first
      -- screen_unknown  : saved contacts are put straight through, the rest
      --                   are screened. The sensible default for someone who
      --                   still wants their family to reach them.
      -- take_messages   : never forward, always take a message
      mode         TEXT NOT NULL DEFAULT 'screen_unknown',
      -- Where a forwarded call is sent. Defaults to the user's own verified
      -- number; NULL disables forwarding entirely.
      forward_to   TEXT,
      -- Names Hari always puts through, whatever the mode.
      vip          TEXT NOT NULL DEFAULT '',
      -- What Hari may tell a caller about availability, in the user's words:
      -- "say I'm in clinic until 4", "don't say where I am".
      availability TEXT NOT NULL DEFAULT '',
      -- May Hari offer an appointment slot? Off by default: it writes to the
      -- user's diary, and that should be a deliberate choice.
      may_book     BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at   BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS inbound_calls (
      id           BIGSERIAL PRIMARY KEY,
      user_id      INTEGER NOT NULL,
      call_id      TEXT NOT NULL,            -- our id, also in the webhook path
      from_number  TEXT NOT NULL,
      caller_name  TEXT,                     -- resolved from contacts, if known
      known        BOOLEAN NOT NULL DEFAULT FALSE,
      -- forwarded | message | booked | answered | missed | blocked
      outcome      TEXT NOT NULL DEFAULT 'answered',
      -- What the caller wanted, in one line, for the user to read at a glance.
      summary      TEXT NOT NULL DEFAULT '',
      -- The message left, verbatim, when there is one.
      message      TEXT NOT NULL DEFAULT '',
      urgency      TEXT NOT NULL DEFAULT 'normal',  -- urgent | normal | low
      transcript   TEXT NOT NULL DEFAULT '',        -- JSON [{who,text}]
      duration_s   INTEGER NOT NULL DEFAULT 0,
      seen         BOOLEAN NOT NULL DEFAULT FALSE,
      created_at   BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_inbound_calls_user
      ON inbound_calls(user_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_inbound_calls_unseen
      ON inbound_calls(user_id, seen) WHERE seen = FALSE;
  `);
}

module.exports = { migrate };
