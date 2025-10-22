// server/server.js
// Simple WebRTC bridge to OpenAI Realtime (voice-only, simple version)
// Requirements:
// - Node 18+
// - Set OPENAI_API_KEY in environment
// - Place client/index.html (client folder) next to server folder
//
// Start: node server.js (or add scripts in package.json)

import express from "express";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
if (!OPENAI_API_KEY) {
  console.error("❌ OPENAI_API_KEY required in environment");
  process.exit(1);
}

// Which realtime model to use (voice-capable)
const OPENAI_REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview-2024-10-01";
// Default voice parameter
const DEFAULT_VOICE = process.env.DEFAULT_VOICE || "verse";

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "../client"))); // serve client files

// Health
app.get("/health", (req, res) => res.json({ ok: true }));

/**
 * POST /offer
 * Body: { sdp: "<client offer sdp>", voice: "verse" }
 * Returns: { answer: "<answer sdp from OpenAI>" }
 *
 * Flow:
 * 1. Receive browser SDP offer
 * 2. POST to OpenAI Realtime Sessions endpoint with the offer
 * 3. Return the answer SDP to browser
 */
app.post("/offer", async (req, res) => {
  try {
    const { sdp, voice } = req.body || {};
    if (!sdp) return res.status(400).json({ error: "Missing sdp in request body" });

    // Build request to OpenAI realtime. This endpoint/contract is the pattern used by
    // OpenAI realtime: exchange SDP with the API to create a direct WebRTC session.
    //
    // NOTE: OpenAI's exact path and request fields can change. If you get a 4xx from OpenAI,
    // check that your API key has realtime enabled and the model name is correct.
    const openaiUrl = `https://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_REALTIME_MODEL)}&voice=${encodeURIComponent(voice || DEFAULT_VOICE)}`;

    // The Realtime endpoint expects a POST with the offer body (application/sdp) and returns
    // an SDP answer (string) in the response. Some deployments return JSON like { sdp: "..." }.
    // We'll send content-type application/sdp and accept text or JSON.
    const resp = await fetch(openaiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/sdp",
        Accept: "application/sdp, application/json, text/plain",
      },
      body: sdp,
      // timeout not set; let platform handle process lifetime
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "<no body>");
      console.error("OpenAI Realtime /offer failed:", resp.status, text.slice ? text.slice(0, 500) : text);
      return res.status(502).json({ error: "OpenAI realtime responded with error", status: resp.status, body: text });
    }

    // Try to interpret response
    const contentType = (resp.headers.get("content-type") || "").toLowerCase();
    let answerSDP = null;
    if (contentType.includes("application/sdp") || contentType.includes("text/plain")) {
      answerSDP = await resp.text();
    } else {
      // maybe JSON { sdp: "..." }
      const j = await resp.json().catch(() => null);
      answerSDP = j?.sdp || j?.answer || (typeof j === "string" ? j : null);
    }

    if (!answerSDP) {
      const body = await resp.text().catch(() => "");
      console.error("No answer SDP received from OpenAI:", body.slice ? body.slice(0, 1000) : body);
      return res.status(502).json({ error: "No answer SDP from OpenAI", body });
    }

    // Return to browser
    return res.json({ answer: answerSDP });
  } catch (err) {
    console.error("Offer handler error:", err?.message || err);
    return res.status(500).json({ error: "server_error", details: err?.message || String(err) });
  }
});

// Fallback to serve index.html for root
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../client/index.html"));
});

const PORT = Number(process.env.PORT || 10000);
app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
  console.log(`Serving client from: ${path.join(__dirname, "../client")}`);
});
