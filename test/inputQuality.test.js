// Regressions measured in production transcripts: valid short commands
// that the gate refused, and the fragments it must keep refusing.
const { assess } = require("../src/agents/inputQuality");
let fail = 0;
const check = (text, want, opts) => {
  const got = assess(text, opts).quality;
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${JSON.stringify(text)} → ${got}${ok ? "" : " (wanted " + want + ")"}`);
};
// Must be clear (were refused before)
check("4:30 a.m. alarm tomorrow", "clear");
check("hotspot", "clear");
check("flashlight", "clear");
check("Open Uber app Uber", "clear");
check("चाय दिखाओ।", "clear");
check("set timer 10 min", "clear");
check("call mom", "clear");
check("volume", "clear");
// Must still be refused
check("con", "garbled");
check("149", "garbled");
check("that that Y2I tab", "weak");
check("el grupo", "garbled");
check("photos photos mein", "weak");
check("Dadi", "garbled");
check("", "garbled");
check("응. Remind me that", "garbled");
check("16366895760", "weak");
check("16366895760", "clear", { expectsNumber: true });
console.log(fail ? `\n${fail} FAILURES` : "\nall pass");
process.exit(fail ? 1 : 0);
