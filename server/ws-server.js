// server/ws-server.js
// WebSocket bridge: Browser <--> This server <--> OpenAI Realtime WebSocket
// Purpose: keep a long-lived connection to OpenAI so calls do not auto-expire.

import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import fetch from "node-fetch";
import dotenv from "dotenv";
import bodyParser from "body-parser";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SHIVAM_BASE = process.env.SHIVAM_BASE;
const SHIVAM_API_KEY = process.env.SHIVAM_API_KEY;
const GEOCODE_KEY = process.env.GEOCODE_KEY || "";
const MODEL_NAME = process.env.MODEL_NAME || "gpt-4o-realtime-preview-2024-10-01";

if (!OPENAI_API_KEY) {
  console.error("❌ OPENAI_API_KEY missing. Set in .env or Render environment.");
  process.exit(1);
}

const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "../client"))); // serve client UI

// ========================================================
// Helper: fetch kundli summary (identical to prior server)
// ========================================================
async function fetchKundliSummary({ name, dob, tob, pob, gender }) {
  // parse dob/tob
  const [year, month, day] = (dob || "").split("-");
  const [hour, min] = (tob || "").split(":");
  // geocode
  let lat = "28.6139", lon = "77.2090";
  if (GEOCODE_KEY && pob) {
    try {
      const r = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(pob)}&key=${GEOCODE_KEY}`);
      const j = await r.json();
      if (j.status === "OK" && j.results?.length) {
        lat = String(j.results[0].geometry.location.lat);
        lon = String(j.results[0].geometry.location.lng);
      }
    } catch (e) { console.warn("Geocode error:", e.message); }
  }
  let summary = `नाम: ${name || "N/A"}, DOB: ${dob || "N/A"} ${tob || ""}, POB: ${pob || "N/A"} (lat:${lat},lon:${lon})`;
  if (SHIVAM_BASE && SHIVAM_API_KEY && name && dob && tob) {
    try {
      const tokenRes = await fetch(`${SHIVAM_BASE}/users/generateToken`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apikey: SHIVAM_API_KEY })
      });
      const tokenJson = await tokenRes.json();
      const authToken = tokenJson?.data?.[0]?.token;
      if (authToken) {
        const payload = { name, day, month, year, hour, min, place: pob, latitude: lat, longitude: lon, timezone: "5.5", gender: (gender||"male").toLowerCase() };
        const astro = await fetch(`${SHIVAM_BASE}/astro/getAstroData`, {
          method: "POST",
          headers: { Authorization: `Bearer ${authToken}`, "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        const astroJson = await astro.json();
        const sun = astroJson?.data?.sun_sign || "";
        const moon = astroJson?.data?.moon_sign || "";
        summary += ` | Sun: ${sun}, Moon: ${moon}`;
      }
    } catch (e) {
      console.warn("Shivam fetch failed:", e.message);
    }
  }
  return summary;
}

// ========================================================
// OpenAI Realtime WS connection manager
// - We keep a single persistent connection to OpenAI.
// - When a browser client connects to our server ws, we attach it to that OpenAI session.
// - Multiple browser clients can be supported by broadcasting or creating separate mappings.
// For simplicity we maintain one server <-> OpenAI connection and allow one browser client at a time.
// ========================================================

let openaiWs = null;
let openaiWsReady = false;
let openaiEventId = 0;

// Create a function to (re)connect to OpenAI WS
async function connectToOpenAI(instructions = "") {
  if (openaiWs) {
    try { openaiWs.terminate(); } catch {}
    openaiWs = null;
  }

  const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(MODEL_NAME)}`;
  console.log("🔌 Connecting to OpenAI Realtime WS:", url);

  openaiWs = new WebSocket(url, {
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" }
  });

  openaiWs.binaryType = "arraybuffer";

  openaiWs.on("open", () => {
    console.log("✅ Connected to OpenAI Realtime WebSocket");
    openaiWsReady = true;
    // send initial system/instructions message to the model
    if (instructions) {
      const msg = {
        type: "input_text",
        id: `init-${Date.now()}`,
        text: instructions
      };
      openaiWs.send(JSON.stringify(msg));
      console.log("ℹ️ Sent initial instructions to model.");
    }
  });

  openaiWs.on("message", (raw) => {
    // OpenAI sends text frames (JSON) and possibly binary frames (audio). We will forward JSON messages to browser clients.
    try {
      // If message is ArrayBuffer -> binary (rare); attempt to parse as text first
      if (typeof raw !== "string" && raw instanceof Buffer) {
        // binary: sometimes OpenAI streams binary audio. We'll forward as { type: "audio.binary", data: base64 }
        const base64 = Buffer.from(raw).toString("base64");
        broadcastToBrowserClients(JSON.stringify({ type: "output_audio_binary", data: base64 }));
        return;
      }

      const msg = JSON.parse(raw.toString());
      // forward relevant events to connected browser clients
      // Common events: output_audio_buffer.append, response.create, message (text tokens), etc.
      broadcastToBrowserClients(JSON.stringify(msg));
    } catch (e) {
      console.warn("Failed to parse openai ws message:", e.message);
    }
  });

  openaiWs.on("close", (code, reason) => {
    openaiWsReady = false;
    console.warn("OpenAI WS closed:", code, reason?.toString?.() || reason);
    // reconnect after a short delay
    setTimeout(() => {
      console.log("🔁 Reconnecting to OpenAI WS...");
      connectToOpenAI(instructions).catch(console.error);
    }, 2000);
  });

  openaiWs.on("error", (err) => {
    openaiWsReady = false;
    console.error("OpenAI WS error:", err?.message || err);
  });
}

// Start OpenAI WS right away with no instructions (we will add on user connect)
connectToOpenAI("").catch(console.error);

// ========================================================
// Browser WebSocket server (client <--> our server)
// ========================================================
const wss = new WebSocketServer({ port: 8080 });
console.log("🛰 WebSocket server listening on ws://0.0.0.0:8080");

const browserClients = new Set();

function broadcastToBrowserClients(msg) {
  for (const c of browserClients) {
    if (c.readyState === WebSocket.OPEN) {
      c.send(msg);
    }
  }
}

wss.on("connection", (ws, req) => {
  console.log("🖥️ Browser client connected");
  browserClients.add(ws);

  // per-client state
  ws.clientState = { attached: false };

  ws.on("message", async (raw) => {
    // Browser sends JSON messages (text) or binary audio in base64 JSON
    try {
      let msg;
      if (typeof raw === "string") {
        msg = JSON.parse(raw);
      } else {
        // assume binary - not used in this client design
        console.warn("Binary received from browser - ignored");
        return;
      }

      // handle message types from browser
      if (msg.type === "init") {
        // { type: "init", name, dob, tob, pob, gender, voice }
        const { name, dob, tob, pob, gender, voice } = msg;
        ws.clientState = { name, dob, tob, pob, gender, voice, attached: true };
        // Build kundli summary and send as instructions to OpenAI (reconnect openai if needed)
        const summary = await fetchKundliSummary({ name, dob, tob, pob, gender });
        const instructions = `You are Sumit Aggarwal, an experienced Vedic astrologer. Kundli: ${summary}. Answer in Hindi succinctly.`;
        // If GPU ws is already open, send input_text, else reconnect and send
        if (openaiWsReady) {
          openaiWs.send(JSON.stringify({ type: "input_text", id: `init-${Date.now()}`, text: instructions }));
        } else {
          // reconnect then will send instructions from connectToOpenAI
          await connectToOpenAI(instructions);
        }
        ws.send(JSON.stringify({ type: "init_ok" }));
      } else if (msg.type === "media") {
        // media chunk: { type:"media", data: "<base64 pcm16>" }
        if (!openaiWsReady) return;
        // Forward to OpenAI as input_audio_buffer.append
        const payload = {
          type: "input_audio_buffer.append",
          audio: msg.data // base64 PCM16LE
        };
        openaiWs.send(JSON.stringify(payload));
      } else if (msg.type === "media_commit") {
        // Browser indicates this is a "segment boundary" and wants model to process queued audio
        // Forward commit and then request response generation
        if (!openaiWsReady) return;
        openaiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        // Request output (ask model to respond)
        openaiWs.send(JSON.stringify({ type: "response.create", response: { instructions: "" } }));
      } else if (msg.type === "stop") {
        // stop call
        ws.close();
      }
    } catch (e) {
      console.warn("Error handling browser message:", e.message);
    }
  });

  ws.on("close", () => {
    browserClients.delete(ws);
    console.log("🖥️ Browser client disconnected");
  });

  ws.on("error", (err) => {
    console.warn("Browser ws error:", err?.message || err);
  });
});

// ========================================================
// Express endpoints (for quick diagnostic)
// ========================================================
app.get("/health", (req, res) => res.json({ ok: true }));
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../client/index_ws.html"));
});
app.listen(PORT, () => console.log(`📡 HTTP server listening on port ${PORT}`));
