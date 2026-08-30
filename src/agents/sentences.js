/**
 * Incremental sentence splitter for streamed model output.
 *
 * Feed text deltas with push(); every COMPLETE sentence is delivered to
 * [onSentence] the moment it finishes, and finish() flushes whatever tail
 * remains. Mirrors the splitter the conversation agent streams with:
 * sentence enders are . ! ? and the Devanagari danda । — and, for the very
 * FIRST chunk only, a long opening sentence is also broken at a clause
 * boundary so time-to-first-audio stays low.
 */
function sentenceSplitter(onSentence) {
  let pending = "";
  let spokeFirst = false;

  const flushComplete = () => {
    const m = pending.match(/^[\s\S]*?[.!?।](?=\s|$)/);
    if (!m) {
      // FIRST CHUNK ONLY: break a long opening sentence at a clause
      // boundary once there are enough words to sound natural on its own.
      if (spokeFirst || pending.length < 60) return;
      const c = pending.match(/^[\s\S]{40,}?[,;:—–](?=\s)/);
      if (!c) return;
      const clause = c[0].replace(/[,;:—–]\s*$/, "").trim();
      if (!clause) return;
      pending = pending.slice(c[0].length).replace(/^\s+/, "");
      spokeFirst = true;
      onSentence(clause);
      return;
    }
    const sentence = m[0].trim();
    pending = pending.slice(m[0].length).replace(/^\s+/, "");
    if (sentence) {
      spokeFirst = true;
      onSentence(sentence);
    }
  };

  return {
    push(delta) {
      pending += String(delta || "");
      let before;
      do {
        before = pending;
        flushComplete();
      } while (pending !== before);
    },
    finish() {
      const tail = pending.trim();
      pending = "";
      if (tail) onSentence(tail);
    },
  };
}

module.exports = { sentenceSplitter };
