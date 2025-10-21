// server/ws-server.js
// AstroOne — Final WebSocket bridge (complete)
// Serves client/index_ws.html and exposes /ws for browser -> this server WS.
// This server keeps a persistent connection to OpenAI realtime WS and forwards audio.

// --- imports
import express from "express";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import fetch from "node-fetch";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import bodyParser from "body-parser";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL_NAME = process.env.MODEL_NAME || "gpt-4o-realtime-preview-2024-10-01";
const DEFAULT_VOICE = process.env.DEFAULT_VOICE || "verse";
const SHIVAM_BASE = process.env.SHIVAM_BASE || "";
const SHIVAM_API_KEY = process.env.SHIVAM_API_KEY || "";
const GEOCODE_KEY = process.env.GEOCODE_KEY || "";

// Allowed voices (update if OpenAI changes)
const VALID_VOICES = ["alloy","ash","ballad","coral","echo","sage","shimmer","verse","marin","cedar"];

// quick check
if (!OPENAI_API_KEY) {
  console.error("❌ OPENAI_API_KEY is required in env");
  process.exit(1);
}

// app + server
const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "../client"))); // serve static client folder

// Serve main page
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../client/index_ws.html"));
});

// http + ws server on same port
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

// ===================================================================
// Helper: fetch Kundli summary (Google geocode + Shivam). Best-effort.
// ===================================================================
async function fetchKundliSummary({ name, dob, tob, pob, gender }) {
  try {
    let lat = "28.6139", lon = "77.2090";
    if (GEOCODE_KEY && pob) {
      try {
        const geo = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(pob)}&key=${GEOCODE_KEY}`);
        const gj = await geo.json();
        if (gj.status === "OK" && gj.results?.length) {
          lat = String(gj.results[0].geometry.location.lat);
          lon = String(gj.results[0].geometry.location.lng);
        }
      } catch (e) { /* ignore */ }
    }

    let summary = `नाम: ${name || "N/A"}, DOB: ${dob||"N/A"} ${tob||""}, POB: ${pob||"N/A"} (lat:${lat},lon:${lon})`;

    if (SHIVAM_BASE && SHIVAM_API_KEY && name && dob && tob) {
      try {
        // get token from Shivam
        const tRes = await fetch(`${SHIVAM_BASE}/users/generateToken`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ apikey: SHIVAM_API_KEY })
        });
        const tjson = await tRes.json().catch(()=>null);
        const authToken = tjson?.data?.[0]?.token;
        if (authToken) {
          const [year,month,day] = (dob||"").split("-");
          const [hour,min] = (tob||"").split(":");
          const payload = { name, day, month, year, hour, min, place: pob, latitude: lat, longitude: lon, timezone: "5.5", gender: (gender||"male").toLowerCase() };
          const aRes = await fetch(`${SHIVAM_BASE}/astro/getAstroData`, {
            method: "POST",
            headers: { Authorization: `Bearer ${authToken}`, "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          });
          const ajson = await aRes.json().catch(()=>null);
          const sun = ajson?.data?.sun_sign || "";
          const moon = ajson?.data?.moon_sign || "";
          if (sun || moon) summary += ` | Sun: ${sun}, Moon: ${moon}`;
        }
      } catch (e) { /* ignore Shivam errors */ }
    }
    return summary;
  } catch (e) {
    return `नाम: ${name||"N/A"}, DOB: ${dob||"N/A"} ${tob||""}, POB: ${pob||"N/A"}`;
  }
}

// ===================================================================
// OpenAI WS management (single persistent connection). Reconnect logic.
// ===================================================================
let openaiWs = null;
let openaiReady = false;
let openaiInstructions = "";
let openaiVoice = DEFAULT_VOICE;

function connectOpenAI(instructions = "", voice = DEFAULT_VOICE) {
  // ensure valid voice
  if (!VALID_VOICES.includes(voice)) voice = DEFAULT_VOICE;
  openaiInstructions = instructions || openaiInstructions;
  openaiVoice = voice || openaiVoice;

  // if ws exists, close then reconnect
  try { if (openaiWs && openaiWs.readyState === WebSocket.OPEN) openaiWs.terminate(); } catch(e){}

  const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(MODEL_NAME)}&voice=${encodeURIComponent(openaiVoice)}`;
  console.log("🔌 connecting to OpenAI realtime WS:", url);

  openaiWs = new WebSocket(url, { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" }});
  openaiWs.binaryType = "arraybuffer";

  openaiWs.on("open", () => {
    console.log("✅ Connected to OpenAI Realtime WS");
    openaiReady = true;
    if (openaiInstructions) {
      // send initial prompt/instructions as input_text
      try { openaiWs.send(JSON.stringify({ type: "input_text", text: openaiInstructions })); } catch(e){}
    }
  });

  openaiWs.on("message", (data) => {
    // data can be binary audio (ArrayBuffer/Buffer) or text JSON events
    try {
      if (typeof data !== "string" && Buffer.isBuffer(data)) {
        // forward binary frames to browser clients as base64 in type output_audio_binary
        const base64 = data.toString("base64");
        broadcastToClients(JSON.stringify({ type: "output_audio_binary", data: base64 }));
        return;
      }
      // else string -> JSON event
      const j = JSON.parse(data.toString());
      // forward events to clients (they may include text tokens, response events, output_audio_buffer.append etc)
      broadcastToClients(JSON.stringify(j));
    } catch (e) {
      console.warn("⚠️ openai message parse error:", e?.message);
    }
  });

  openaiWs.on("close", (code, reason) => {
    console.warn("⚠️ OpenAI WS closed:", code, reason?.toString?.slice(0,200));
    openaiReady = false;
    // reconnect after short delay
    setTimeout(() => {
      try { connectOpenAI(openaiInstructions, openaiVoice); } catch(e){}
    }, 2000);
  });

  openaiWs.on("error", (err) => {
    openaiReady = false;
    console.error("❌ OpenAI WS error:", err?.message || err);
  });
}

// start OpenAI connection once (with no instructions). Will be re-used and re-initialized per client init.
connectOpenAI("", DEFAULT_VOICE);

// ===================================================================
// Browser WebSocketServer (same HTTP server, path /ws)
// Clients send: init, media (base64 PCM16), media_commit, stop
// ===================================================================
const clients = new Set();
function broadcastToClients(msg) {
  for (const c of clients) {
    try { if (c.readyState === WebSocket.OPEN) c.send(msg); } catch(e){}
  }
}

// Keep track of per-client timers if needed (not used right now)
wss.on("connection", (ws, req) => {
  console.log("🖥️ Browser connected");
  clients.add(ws);

  ws.on("message", async (raw) => {
    try {
      const parsed = JSON.parse(raw.toString());
      if (!parsed || !parsed.type) return;

      if (parsed.type === "init") {
        // parsed: { type: "init", name, dob, tob, pob, gender, voice }
        const { name, dob, tob, pob, gender, voice } = parsed;
        const kundli = await fetchKundliSummary({ name, dob, tob, pob, gender });
        const instructions = `You are Sumit Aggarwal, an experienced Vedic astrologer. Kundli summary: ${kundli}. Answer in Hindi clearly and concisely.`;
        // connect or reconfigure OpenAI WS with instructions + chosen voice
        connectOpenAI(instructions, (VALID_VOICES.includes(voice) ? voice : DEFAULT_VOICE));
        // ack client
        try { ws.send(JSON.stringify({ type: "init_ok" })); } catch(e){}
        return;
      }

      if (parsed.type === "media") {
        // client sending base64 PCM16 audio chunk
        if (!openaiReady) return; // drop until openai ready
        // forward to OpenAI: input_audio_buffer.append with base64 audio
        try {
          openaiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: parsed.data }));
        } catch (e) {
          // if not ready, ignore
        }
        return;
      }

      if (parsed.type === "media_commit") {
        // commit buffer and ask model to respond
        if (!openaiReady) return;
        try {
          openaiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
          // ask model to produce a response (this triggers audio output)
          openaiWs.send(JSON.stringify({ type: "response.create", response: { instructions: "" } }));
        } catch (e) { /* ignore */ }
        return;
      }

      if (parsed.type === "stop") {
        try { ws.close(); } catch (e) {}
        return;
      }
    } catch (e) {
      console.warn("⚠️ Browser WS message parse error:", e?.message);
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    console.log("🖥️ Browser disconnected");
  });

  ws.on("error", (err) => {
    console.warn("Browser WS error:", err?.message || err);
    try { ws.close(); } catch {}
  });
});

// Keep-alive ping to prevent free-tier sleeping; adjust to your domain
setInterval(() => {
  try { fetch(process.env.KEEP_ALIVE_URL || `https://${process.env.RENDER_EXTERNAL_URL || process.env.HOSTNAME || "localhost"}`); } catch (e) {}
}, 30000);

// start server
server.listen(PORT, () => {
  console.log(`🚀 AstroOne Realtime WS server listening on port ${PORT}`);
});
