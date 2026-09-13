/**
 * WHAT THE AGENT KNOWS WHEN IT PICKS UP THE PHONE.
 * ----------------------------------------------------------------------
 * A call placed on someone's behalf is only useful if it carries what they
 * would have said themselves. Asked to ring a dealer about a car, an agent
 * that does not know which model, which colour, or what the caller is
 * willing to pay is a voicemail with extra steps — it can deliver a
 * sentence, and it cannot negotiate.
 *
 * So the brief is assembled from the SAME memory the in-app assistant
 * uses: memoryBlock() is what already gives the live conversation its
 * "personal context", and it is handed to the phone agent unchanged. There
 * is no second store to keep in step.
 *
 * THE RULES IT IS GIVEN MATTER AS MUCH AS THE FACTS. An agent on a real
 * call with a real salesperson can do lasting damage: it must never agree
 * a price, never commit to a purchase, and never invent a preference the
 * caller did not express. Those are stated as prohibitions rather than
 * suggestions, because the model follows the prompt and the person on the
 * other end cannot tell the difference.
 */
const memory = require("../agents/memory");
const userCtx = require("../users/context");

/**
 * Build the system prompt for one outbound call.
 *
 * @param {number} userId   whose behalf the call is made on
 * @param {object} call     { task, contactName, mode }
 */
async function build(userId, call = {}) {
  const task = String(call.task || "").trim();
  const who = String(call.contactName || "").trim();

  // The same two sources the live conversation uses. Both are best-effort:
  // a call must still go out if memory is briefly unavailable, it just
  // negotiates with less.
  const [profile, memBlock] = await Promise.all([
    userCtx.getProfile(userId).catch(() => null),
    memory.memoryBlock(userId).catch(() => ""),
  ]);
  const userName =
    (profile && profile.user && profile.user.name) || "the person I work for";

  const lines = [
    `You are a personal assistant making a phone call on behalf of ${userName}.`,
    `You are speaking to ${who || "the person who answered"} on a real telephone call.`,
    "",
    `WHAT YOU WERE ASKED TO DO: ${task}`,
    "",
    "HOW TO SPEAK",
    "- Say who you are in the first sentence: you are calling on behalf of " +
      `${userName}. Never pretend to be them.`,
    "- One thought per turn. This is a phone call, not a written message.",
    "- Let them finish. If they talk while you are talking, stop and listen.",
    "- If they ask something you were not told, say you will check with " +
      `${userName} and come back — do not guess on their behalf.`,
    "",
    "WHAT YOU MUST NOT DO",
    "- Do NOT agree a price, place an order, confirm a booking or commit to " +
      "anything. You are gathering and negotiating, not deciding. If they " +
      "push for a yes, say you need to confirm with " + userName + " first.",
    "- Do NOT invent a preference, a budget or a deadline you were not " +
      "given. Saying 'I am not sure' is correct; making something up is not.",
    "- Do NOT share anything personal beyond what the task needs.",
    "",
    "NEGOTIATING",
    "- Ask for their best price before offering one of your own.",
    "- If a number is quoted, ask what it includes, and whether anything can " +
      "be improved — delivery, extras, timing.",
    "- Report back what was actually said. An agreed figure you could not " +
      "get is worth less than an honest 'they would not move'.",
  ];

  if (memBlock) {
    lines.push(
      "",
      `WHAT YOU KNOW ABOUT ${userName.toUpperCase()} — use it to answer their`,
      "questions and to steer the conversation. It is background, not a",
      "script, and not everything here will be relevant to this call.",
      memBlock
    );
  }

  return lines.join("\n");
}

module.exports = { build };
