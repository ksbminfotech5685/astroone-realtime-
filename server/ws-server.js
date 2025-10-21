// server/ws-server.js
// ==============================================
// AstroOne — Final Stable Realtime WebSocket Server
// - Serves client/index_ws.html
// - Single HTTP server + WebSocket at path /ws (Render-friendly)
// - Maintains one persistent OpenAI Realtime WebSocket using your OPENAI_API_KEY
// - Forwards audio from browser -> OpenAI (input_audio_buffer.append)
// - Sends commit + response.create to cause voice output
// - Forwards binary audio frames from OpenAI -> browser (base64)
// - Safely logs errors, auto-reconnects OpenAI WS
// - Calls Shivam + Google geocode to create Kundli summary on init
// ==============================================

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

// ---------- Config ----------
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const MODEL_NAME = process.env.MODEL_NAME || "gpt-4o-realtime-preview-2024-10-01";
const DEFAULT_VOICE = process.env.DEFAULT_VOICE || "verse";
const GEOCODE_KEY = process.env.GEOCODE_KEY || "";
const SHIVAM_BASE = process.env.SHIVAM_BASE || "";
const SHIVAM_API_KEY = process.env.SHIVAM_API_KEY || "";

// Allowed voices (current valid list — update if OpenAI changes)
const VALID_VOICES = ["alloy","ash","ballad","coral","echo","sage","shimmer","verse","marin","cedar"];

if (!OPENAI_API_KEY) {
  console.error("❌ ERROR: OPENAI_API_KEY is required in environment variables.");
  process.exit(1);
}

// ---------- Express + static ----------
const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "../client")));
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../client/index_ws.html"));
});

// ---------- HTTP server + WebSocket server (same port) ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

// ---------- Helpers: Kundli (Google geocode + Shivam) ----------
async function geocodePlace(place) {
  if (!GEOCODE_KEY || !place) return { lat: null, lon: null };
  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(place)}&key=${GEOCODE_KEY}`;
    const r = await fetch(url);
    const j = await r.json();
    if (j.status === "OK" && j.results?.length) {
      const { lat, lng } = j.results[0].geometry.location;
      return { lat: String(lat), lon: String(lng) };
    }
  } catch (e) {
    console.warn("Geocode error:", e?.message || e);
  }
  return { lat: null, lon: null };
}

async function fetchShivamKundli(name, dob, tob, pob, gender) {
  if (!SHIVAM_BASE || !SHIVAM_API_KEY) return null;
  try {
    // generate token
    const tokRes = await fetch(`${SHIVAM_BASE}/users/generateToken`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apikey: SHIVAM_API_KEY })
    });
    const tokJson = await tokRes.json().catch(()=>null);
    const token = tokJson?.data?.[0]?.token;
    if (!token) return null;

    // build payload (Shivam expects day, month, year, hour, min)
    const [year, month, day] = (dob || "").split("-");
    const [hour, min] = (tob || "").split(":");
    const payload = { name, day, month, year, hour, min, place: pob, latitude: "", longitude: "", timezone: "5.5", gender: (gender||"male").toLowerCase() };

    // call for astro data
    const astroRes = await fetch(`${SHIVAM_BASE}/astro/getAstroData`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const astroJson = await astroRes.json().catch(()=>null);
    return astroJson?.data || null;
  } catch (e) {
    console.warn("Shivam fetch error:", e?.message || e);
    return null;
  }
}

async function buildKundliSummary({ name, dob, tob, pob, gender }) {
  try {
    let lat = null, lon = null;
    if (pob && GEOCODE_KEY) {
      const geo = await geocodePlace(pob);
      lat = geo.lat; lon = geo.lon;
    }
    let summary = `नाम: ${name || "N/A"}, DOB: ${dob || "N/A"} ${tob || ""}, POB: ${pob || "N/A"} (lat:${lat||"NA"}, lon:${lon||"NA"})`;
    if (SHIVAM_BASE && SHIVAM_API_KEY && name && dob && tob) {
      const astro = await fetchShivamKundli(name, dob, tob, pob, gender);
      if (astro) {
        const sun = astro.sun_sign || astro?.sun || "";
        const moon = astro.moon_sign || astro?.moon || "";
        summary += ` | Sun: ${sun}, Moon: ${moon}`;
      }
    }
    return summary;
  } catch {
    return `नाम: ${name || "N/A"}, DOB: ${dob || "N/A"}`;
  }
}

// ---------- OpenAI Realtime WS management (persistent) ----------
let openaiWs = null;
let openaiReady = false;
let openaiVoice = DEFAULT_VOICE;
let openaiInstructions = "";

function safeLogOpenAIClose(code, reason) {
  let reasonText = "";
  try {
    if (reason && typeof reason === "string") reasonText = reason;
    else if (reason && reason.toString) reasonText = reason.toString();
  } catch (e) {}
  console.warn("⚠️ OpenAI WS closed:", code, reasonText.slice ? reasonText.slice(0,200) : reasonText);
}

function connectOpenAI(instructions = "", voice = DEFAULT_VOICE) {
  try {
    if (!VALID_VOICES.includes(voice)) voice = DEFAULT_VOICE;
    // If already connected, optionally send instructions and return
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
      if (instructions) {
        try { openaiWs.send(JSON.stringify({ type: "input_text", text: instructions })); } catch {}
      }
      return;
    }

    openaiVoice = voice;
    openaiInstructions = instructions;

    const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(MODEL_NAME)}&voice=${encodeURIComponent(openaiVoice)}`;
    console.log("🔌 connecting to OpenAI realtime WS:", url);

    openaiWs = new WebSocket(url, {
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" }
    });
    openaiWs.binaryType = "arraybuffer";

    openaiWs.on("open", () => {
      console.log("✅ Connected to OpenAI Realtime WS");
      openaiReady = true;
      // send initial instructions if provided
      if (openaiInstructions) {
        try { openaiWs.send(JSON.stringify({ type: "input_text", text: openaiInstructions })); } catch {}
      }
    });

    openaiWs.on("message", (data) => {
      try {
        // binary audio frames (ArrayBuffer/Buffer) -> forward as base64
        if (typeof data !== "string" && Buffer.isBuffer(data)) {
          const base64 = data.toString("base64");
          broadcastToClients(JSON.stringify({ type: "output_audio_binary", data: base64 }));
          return;
        }
        // text frames: forward as-is (they may contain text tokens, response events, buffer append events)
        const msg = JSON.parse(data.toString());
        broadcastToClients(JSON.stringify(msg));
      } catch (e) {
        console.warn("OpenAI message parse error:", e?.message || e);
      }
    });

    openaiWs.on("close", (code, reason) => {
      safeLogOpenAIClose(code, reason);
      openaiReady = false;
      // reconnect after delay
      setTimeout(() => connectOpenAI(openaiInstructions, openaiVoice), 2000);
    });

    openaiWs.on("error", (err) => {
      console.error("❌ OpenAI WS error:", err?.message || err);
      openaiReady = false;
    });
  } catch (e) {
    console.error("connectOpenAI error:", e?.message || e);
  }
}

// Start initial connection (no instructions). We'll send instructions on client init.
connectOpenAI("", DEFAULT_VOICE);

// ---------- Browser WS server (path /ws) ----------
const clients = new Set();
function broadcastToClients(msg) {
  for (const c of clients) {
    try {
      if (c.readyState === WebSocket.OPEN) c.send(msg);
    } catch (e) {}
  }
}

wss.on("connection", (ws, req) => {
  console.log("🖥 Browser connected");
  clients.add(ws);

  ws.on("message", async (raw) => {
    try {
      const parsed = JSON.parse(raw.toString());
      if (!parsed?.type) return;

      // INIT: build Kundli summary and instruct model
      if (parsed.type === "init") {
        const { name, dob, tob, pob, gender, voice } = parsed;
        const kundliSummary = await buildKundliSummary({ name, dob, tob, pob, gender });
        const instructions = `You are Sumit Aggarwal, an experienced Vedic astrologer. Kundli: ${kundliSummary}. Answer in Hindi clearly and concisely.`;
        // connectOpenAI will either reuse existing WS or init a new one and send instructions
        connectOpenAI(instructions, (VALID_VOICES.includes(voice) ? voice : DEFAULT_VOICE));
        try { ws.send(JSON.stringify({ type: "init_ok" })); } catch {}
        return;
      }

      // MEDIA: base64 PCM16 audio chunk from browser
      if (parsed.type === "media") {
        if (!openaiReady) return; // drop until openai is ready
        try { openaiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: parsed.data })); } catch (e) {}
        return;
      }

      // MEDIA_COMMIT: commit and request model response
      if (parsed.type === "media_commit") {
        if (!openaiReady) return;
        try {
          openaiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
          // ask model to generate response (this triggers audio output)
          openaiWs.send(JSON.stringify({ type: "response.create", response: { instructions: "" } }));
        } catch (e) {}
        return;
      }

      // STOP: close client
      if (parsed.type === "stop") {
        try { ws.close(); } catch (e) {}
        return;
      }
    } catch (e) {
      console.warn("Browser WS message parse error:", e?.message || e);
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    console.log("🖥 Browser disconnected");
  });

  ws.on("error", (err) => {
    console.warn("Browser WS error:", err?.message || err);
    try { ws.close(); } catch {}
  });
});

// ---------- Keep-alive ping (safe) ----------
setInterval(() => {
  try {
    const base = process.env.RENDER_EXTERNAL_URL || process.env.KEEP_ALIVE_URL || "";
    if (base && base.startsWith("http")) fetch(base).catch(()=>{});
  } catch {}
}, 30000);

// ---------- Start server ----------
server.listen(PORT, () => {
  console.log(`🚀 AstroOne Realtime WS server listening on port ${PORT}`);
});
