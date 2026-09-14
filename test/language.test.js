const L = require("../src/agents/language.js");

const ASK = [
  // [utterance, expected language, expected permanent]
  ["speak in English", "English", true],
  ["speak English", "English", true],
  ["please speak English", "English", true],
  ["just talk to me in English", "English", true],
  ["speak english from now on", "English", true],
  ["can you talk to me in English please", "English", true],
  ["reply in Hindi only", "Hindi", true],
  ["switch to Kannada", "Kannada", true],
  ["please continue in Tamil", "Tamil", true],
  ["English please", "English", true],
  ["Kannada only", "Kannada", true],
  ["hindi mein baat karo", "Hindi", true],
  ["english me bolo", "English", true],
  ["hindi mein jawab do", "Hindi", true],
  ["kannada alli maatadi", "Kannada", true],
  ["tamil la pesunga", "Tamil", true],
  ["telugu lo matladandi", "Telugu", true],
  ["हिंदी में बात करो", "Hindi", true],
  ["ಕನ್ನಡದಲ್ಲಿ ಮಾತಾಡಿ", "Kannada", true],
  ["தமிழில் பேசு", "Tamil", true],
  ["ಇಂಗ್ಲಿಷ್‌ನಲ್ಲಿ ಮಾತಾಡಿ", "English", true],
  ["ஆங்கிலத்தில் பேசுங்கள்", "English", true],
  ["മലയാളത്തിൽ പറയൂ", "Malayalam", true],
  ["English", "English", true],
  ["हिन्दी", "Hindi", true],
  // one-off: switch this reply, do not rewrite tomorrow's greeting
  // answers to the one question the assistant is allowed to ask
  ["English is fine", "English", true],
  ["I'd prefer Hindi", "Hindi", true],
  ["I would like you to speak Kannada", "Kannada", true],
  ["let's do English", "English", true],
  ["Tamil is better for me", "Tamil", true],
  ["Hindi please", "Hindi", true],
  ["say it in Hindi", "Hindi", false],
  ["write that in Kannada", "Kannada", false],
  // not a request about the conversation at all
  ["translate this to Hindi", "", false],
  ["how do you say hello in Tamil", "", false],
  ["what is the Kannada word for rain", "", false],
  ["play a Hindi song", "", false],
  ["show me Hindi news", "", false],
  ["my daughter is learning Tamil", "", false],
  ["I speak Hindi and English at home", "", false],
  ["book a Kannada movie ticket", "", false],
  ["play Hindi songs", "", false],
  ["I want a Tamil movie tonight", "", false],
  ["set a timer for ten minutes", "", false],
  ["what is the capital of India", "", false],
  // a complaint names the language it is complaining about
  ["don't talk to me in Hindi", "", false],
  ["dont talk to me in hindi", "", false],
  ["stop replying in Hindi", "", false],
  ["never speak to me in Hindi", "", false],
  ["I dont want you to speak in Hindi", "", false],
  ["why do you keep talking to me in Hindi", "", false],
  ["are you speaking in Hindi", "", false],
  ["can you speak Tamil", "", false],
  // an errand for someone else, not a standing preference
  ["call my mother and talk to her in Kannada", "", false],
  ["send the message to them in Tamil", "", false],
  ["remind me about the English exam", "", false],
  ["is Hindi harder than Tamil", "", false],
  ["open the Kannada newspaper app", "", false],
];

const SPOKEN = [
  // [text, language, evidence]
  ["मुझे कल का मौसम बताओ", "Hindi", "script"],
  ["ಇವತ್ತಿನ ಹವಾಮಾನ ಹೇಗಿದೆ", "Kannada", "script"],
  ["இன்றைய வானிலை என்ன", "Tamil", "script"],
  ["ఈరోజు వాతావరణం ఎలా ఉంది", "Telugu", "script"],
  ["what is the weather like tomorrow", "English", "latin"],
  ["set a reminder for my meeting at five", "English", "latin"],
  // romanised Indian speech is that language, and only ever suggestive
  ["kal ka mausam kaisa hai bhai", "Hindi", "latin"],
  ["mujhe kuchh paani chahiye", "Hindi", "latin"],
  ["nale hegidira nimma plan", "Kannada", "latin"],
  // too short to judge — said the same way in every language here
  ["ok", "", ""],
  ["yes", "", ""],
  ["stop", "", ""],
  // Latin, but not English: a mis-transcribed Indian language must NOT
  // come back as positive evidence that the user speaks English
  ["Obrigado pela sua ajuda", "", ""],
  ["Bene grazie molto piacere", "", ""],
  // the recogniser guessed wrong; never mirror this
  ["これはテストです", "", ""],
  ["오늘 날씨 어때", "", ""],
];

let fail = 0;
console.log("── requestedLanguage ──");
for (const [t, lang, perm] of ASK) {
  const r = L.requestedLanguage(t);
  const ok = r.language === lang && (!lang || r.permanent === perm);
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${JSON.stringify(t).padEnd(40)} -> ${JSON.stringify(r)}  expected ${lang || "(none)"}${lang ? (perm ? " permanent" : " one-off") : ""}`);
}
console.log("\n── detectSpoken ──");
for (const [t, lang, ev] of SPOKEN) {
  const r = L.detectSpoken(t);
  const ok = r.language === lang && r.evidence === ev;
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${JSON.stringify(t).padEnd(40)} -> ${JSON.stringify(r)}  expected ${lang || "(unsure)"}${ev ? "/" + ev : ""}`);
}
console.log("\n\u2500\u2500 askWhich \u2500\u2500");
const hi = ["मुझे कल का मौसम बताओ", "आज की खबरें दिखाओ", "दस मिनट का टाइमर लगाओ"];
const ta = ["இன்றைய வானிலை என்ன", "எனக்கு ஒரு நினைவூட்டல் வை", "அந்த செய்தியை காட்டு"];
const en = ["what is the weather like", "set a timer for ten minutes", "show me the news"];
const ASK_CASES = [
  ["stored English, speaks Devanagari -> ask, but name nothing (Hindi/Marathi/Konkani share it)",
   { preferred: "English", userTurns: hi }, true, ""],
  ["stored English, speaks Tamil -> script is decisive, so name it",
   { preferred: "English", userTurns: ta }, true, "Tamil"],
  ["stored Marathi, speaks Devanagari -> same family, nothing to resolve",
   { preferred: "Marathi", userTurns: hi }, false, ""],
  ["stored Hindi, speaks Hindi -> they agree",
   { preferred: "Hindi", userTurns: hi }, false, ""],
  ["armed by hand, no script evidence -> ask, open question",
   { preferred: "English", askedAt: -1, userTurns: en }, true, ""],
  ["armed by hand, speaks Tamil -> ask and offer Tamil",
   { preferred: "English", askedAt: -1, userTurns: ta }, true, "Tamil"],
  ["armed by hand, shared script -> ask without naming it",
   { preferred: "English", askedAt: -1, userTurns: hi }, true, ""],
  ["already asked once -> never again",
   { preferred: "English", askedAt: 1, userTurns: hi }, false, ""],
  ["only Latin evidence -> a run of bad transcripts is not intent",
   { preferred: "Hindi", userTurns: en }, false, ""],
  ["one turn -> below the evidence bar",
   { preferred: "English", userTurns: [hi[0]] }, false, ""],
];
for (const [name, arg, ask, lang] of ASK_CASES) {
  const r = L.askWhich(arg);
  const ok = r.ask === ask && r.language === lang;
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${JSON.stringify(r).padEnd(32)} ${name}`);
}
console.log("\n\u2500\u2500 scriptAmbiguous \u2500\u2500");
for (const [v, exp] of [["Hindi", true], ["Marathi", true], ["Tulu", true], ["Kannada", true], ["Tamil", false], ["English", false], ["Telugu", false]]) {
  const r = L.scriptAmbiguous(v); const ok = r === exp; if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"}  scriptAmbiguous(${JSON.stringify(v)}) -> ${r}`);
}
console.log("\n── canonical / mirrorable ──");
for (const [v, exp] of [["hindi", "Hindi"], ["हिन्दी", "Hindi"], ["  English ", "English"], ["", ""], ["Klingon", "Klingon"]]) {
  const r = L.canonical(v);
  const ok = r === exp; if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"}  canonical(${JSON.stringify(v)}) -> ${JSON.stringify(r)}`);
}
for (const [v, exp] of [["Hindi", true], ["french", false], ["Japanese", false], ["Tulu", true]]) {
  const r = L.mirrorable(v); const ok = r === exp; if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"}  mirrorable(${JSON.stringify(v)}) -> ${r}`);
}
console.log(fail ? `\n${fail} FAILURES` : "\nall pass");
process.exit(fail ? 1 : 0);
