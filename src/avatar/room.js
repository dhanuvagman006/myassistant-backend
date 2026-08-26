const router = require("express").Router();

router.all("*", (req, res) => {
  res.set("Content-Type", "text/html; charset=utf-8");
  res.removeHeader("Content-Security-Policy");
  res.set("Content-Security-Policy", "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:;");
  res.send(`<!doctype html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
  <style>
    body, html { margin: 0; padding: 0; width: 100vw; height: 100vh; background: black; overflow: hidden; }
    video { width: 100%; height: 100%; object-fit: cover; }
    #status { position: absolute; top: 10px; left: 10px; color: rgba(255,255,255,0.5); font-family: sans-serif; font-size: 12px; }
  </style>
</head>
<body>
  <div id="status">Connecting D-ID...</div>
  <video id="agent-video" autoplay playsinline></video>
  <script type="module">
    import * as did from "https://esm.sh/@d-id/client-sdk@latest";
    
    // Using the user's provided API key from their .env
    const clientKey = "${process.env.D_ID_API_KEY || ''}"; 
    // And the provided Expressives avatar_id / agent_id
    const agentId = "${process.env.D_ID_AGENT_ID || ''}"; 
    
    const videoElement = document.getElementById("agent-video");
    const status = document.getElementById("status");

    async function init() {
      if (!clientKey) {
        status.innerText = "Error: D_ID_API_KEY not set in backend .env";
        return;
      }
      try {
        const callbacks = {
          onSrcObjectReady(value) {
            videoElement.srcObject = value;
            status.innerText = ""; // Hide status when connected
          },
          onConnectionStateChange(state) {
            status.innerText = "State: " + state;
          },
          onVideoStateChange(state) {
            if (state === "STOP") {
               // video stopped
            }
          }
        };

        const agent = await did.createAgentManager(agentId, {
          auth: { type: "key", clientKey: clientKey },
          callbacks: callbacks
        });
        
        await agent.connect();
        await agent.chat("Hello! I am connected and ready.");
      } catch (err) {
        status.innerText = "Error: " + err.message;
        console.error(err);
      }
    }
    
    init();
  </script>
</body>
</html>`);
});

module.exports = router;
