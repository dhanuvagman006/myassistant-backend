/**
 * END-TO-END TURN HARNESS — runs REAL utterances through the REAL agent
 * runtime (model, tools, claim-check, everything) in-process on the pod,
 * and prints which tools ran and what would be spoken.
 *
 *   node scripts/e2e-turns.js [userId]
 *
 * Read-only in spirit: utterances are chosen so nothing destructive runs
 * (no sends, no deletes). Device actions are captured, not delivered —
 * there is no phone on the other end of this harness.
 */
process.env.NODE_NO_WARNINGS = "1";

const runtime = require("../src/agents/runtime");

const UID = Number(process.argv[2] || 34);

// The same shape the live proxy builds from the socket URL.
const CTX = {
  userId: UID,
  name: "Dhanush",
  lat: 13.0827,
  lng: 77.5877,
  city: "Bengaluru",
  platform: "android",
  tzOffsetMin: 330,
  source: "e2e",
  deviceCaps: {
    platform: "android",
    build: 58,
    granted: ["contacts", "phone", "microphone", "camera", "location",
              "notifications", "install_packages"],
    denied: [],
  },
};

const CASES = [
  { name: "open swiggy", text: "Open Swiggy",
    expectTool: /open_named_app|open_app/, forbidTool: /phone_control/ },
  { name: "restaurants nearby", text: "Which is the best restaurant near me?",
    expectTool: /open_app/, forbidTool: /phone_control/, maxWords: 30 },
  { name: "open unknown app", text: "Open Slice",
    forbidTool: /phone_control/ },
  { name: "call recall", text: "What did I speak with Gopal on the phone?",
    expectTool: /call_recall/ },
  { name: "battery", text: "What's my battery level?",
    expectTool: /phone_control/ },
  { name: "farewell", text: "Okay, thank you. Bye!",
    expectTool: /end_conversation/, maxWords: 6 },
];

(async () => {
  let failures = 0;
  for (const c of CASES) {
    const tools = [];
    const actions = [];
    const sentences = [];
    let result;
    try {
      result = await runtime.runAgentTurn(c.text, { ...CTX }, (ev, data) => {
        if (ev === "tool_start") tools.push(data?.name || "");
        if (ev === "device_action" || ev === "deviceAction") {
          actions.push(data?.type || JSON.stringify(data).slice(0, 80));
        }
        if (ev === "sentence") sentences.push(data?.text || "");
      });
    } catch (e) {
      console.log(`✗ ${c.name}: TURN THREW — ${e.message}`);
      failures++;
      continue;
    }
    const reply = String(result?.text ?? sentences.join(" ")).trim();
    const toolStr = tools.join(",") || "(none)";
    const words = reply.split(/\s+/).filter(Boolean).length;
    const problems = [];
    if (c.expectTool && !c.expectTool.test(toolStr)) {
      problems.push(`expected tool ${c.expectTool} — got ${toolStr}`);
    }
    if (c.forbidTool && c.forbidTool.test(toolStr)) {
      problems.push(`forbidden tool ran: ${toolStr}`);
    }
    if (c.maxWords && words > c.maxWords) {
      problems.push(`reply too long: ${words} words`);
    }
    const mark = problems.length ? "✗" : "✓";
    if (problems.length) failures++;
    console.log(`${mark} ${c.name}`);
    console.log(`    tools: ${toolStr}`);
    if (actions.length) console.log(`    device: ${actions.join(" | ")}`);
    console.log(`    reply(${words}w): ${reply.slice(0, 220)}`);
    for (const p of problems) console.log(`    !! ${p}`);
  }
  console.log(failures ? `\n${failures} CASE(S) FAILED` : "\nALL CASES PASSED");
  process.exit(failures ? 1 : 0);
})();
