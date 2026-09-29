/**
 * THE OLD WAYS IN, CLOSED WITH A REASON.
 *
 * Until 2026-09-29 the app talked to its assistant through this server's
 * model routes: the /live/ws speech-to-speech socket, the /assistant
 * voice loop (session, SSE stream, audio and text turns, confirmations),
 * /stt, /tts and /vision. The app now runs its models itself (Firebase AI
 * Logic, src/ai/), and those routes are gone. An old build that still
 * calls them gets 426 Upgrade Required with one plain sentence — never a
 * 404 that reads as "the server is down".
 */
const MESSAGE = "Update the app to keep talking to your assistant.";

function gone(_req, res) {
  res.status(426).json({ error: MESSAGE });
}

/**
 * The /live/ws upgrade is answered the same way; any other upgrade is not
 * ours and is closed (with an upgrade listener registered, Node no longer
 * closes those by itself).
 */
function attachUpgrade(server) {
  server.on("upgrade", (req, socket) => {
    socket.on("error", () => {});
    let path = "";
    try { path = new URL(req.url, "http://localhost").pathname; } catch (_) {}
    if (path === "/live/ws") {
      const body = JSON.stringify({ error: MESSAGE });
      socket.end(
        "HTTP/1.1 426 Upgrade Required\r\n" +
        "Content-Type: application/json; charset=utf-8\r\n" +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        "Connection: close\r\n\r\n" + body
      );
      return;
    }
    socket.destroy();
  });
}

module.exports = { gone, attachUpgrade, MESSAGE };
