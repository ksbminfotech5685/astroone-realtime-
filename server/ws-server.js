// server/ws-server.js
// Final stable AstroOne Realtime server
// - Express static server serving client/index_ws.html
// - WebSocket endpoint /ws for browser clients
// - Persistent OpenAI Realtime WebSocket (input_audio_buffer.*, response.create)
// - Shivam kundli + Google geocode support on init
// - Auto-cleanup (delete old audio/temp files older than 5 minutes)
// - Safe logging and reconnect logic
// - Node module type: ESM

import express from "express";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import fetch from "node-fetch";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import bodyParser from "body-parser";

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const MODEL_NAME = process.env.MODEL_NAME || "gpt-4o-realtime-preview-2024-10-01";
const DEFAULT_VOICE = process.env.DEFAULT_VOICE || "verse";
const GEOCODE_KEY = process.env.GEOCODE_KEY || "";
const SHIVAM_BASE = process.env.SHIVAM_BASE || "";
const SHIVAM_API_KEY = process.env.SHIVAM_API_KEY || "";

const VALID_VOICES = ["alloy","ash","ballad","coral","echo","sage","shimmer","verse","marin","cedar"];

if (!OPENAI_API_KEY) {
  console.error("❌ OPENAI_API_KEY is required in environment.");
  process.exit(1);
}

/* ---------- Express setup ---------- */
const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "../client")));
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../client/index_ws.html"));
});

/* ---------- HTTP + WS server ---------- */
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

/* ---------- Helpers: Geocode + Shivam ---------- */
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
    const tokenResp = await fetch(`${SHIVAM_BASE}/users/generateToken`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apikey: SHIVAM_API_KEY }),
    });
    const tokenJson = await tokenResp.json().catch(() => null);
    const token = tokenJson?.data?.[0]?.token;
    if (!token) return null;

    const [year, month, day] = (dob || "").split("-");
    const [hour, min] = (tob || "").split(":");
    const payload = { name, day, month, year, hour, min, place: pob, latitude: "", longitude: "", timezone: "5.5", gender: (gender || "male").toLowerCase() };

    const res = await fetch(`${SHIVAM_BASE}/astro/getAstroData`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const js = await res.json().catch(() => null);
    return js?.data || null;
  } catch (e) {
    console.warn("Shivam error:", e?.message || e);
    return null;
  }
}

async function buildKundliSummary({ name, dob, tob, pob, gender }) {
  let summary = `नाम: ${name || "N/A"}, DOB: ${dob || "N/A"} ${tob || ""}, POB: ${pob || "N/A"}`;
  try {
    if (pob && GEOCODE_KEY) {
      const geo = await geocodePlace(pob);
      summary += ` (lat:${geo.lat || "NA"}, lon:${geo.lon || "NA"})`;
    }
    if (SHIVAM_BASE && SHIVAM_API_KEY && name && dob && tob) {
      const astro = await fetchShivamKundli(name, dob, tob, pob, gender);
      if (astro) {
        summary += ` | Sun:${astro.sun_sign || astro?.sun || ""}, Moon:${astro.moon_sign || astro?.moon || ""}`;
      }
    }
  } catch {}
  return summary;
}

/* ---------- OpenAI Realtime WS management ---------- */
let openaiWs = null;
let openaiReady = false;
let openaiVoice = DEFAULT_VOICE;
let openaiInstructions = "";

function safeStringifyReason(reason) {
  try {
    if (!reason) return "";
    if (typeof reason === "string") return reason;
    if (reason.toString) return reason.toString();
    return JSON.stringify(reason).slice(0, 200);
  } catch {
    return "";
  }
}

function connectOpenAI(instructions = "", voice = DEFAULT_VOICE) {
  if (!VALID_VOICES.includes(voice)) voice = DEFAULT_VOICE;
  if (instructions) openaiInstructions = instructions;
  openaiVoice = voice;

  // Reuse existing open socket if open
  if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
    if (instructions) {
      try { openaiWs.send(JSON.stringify({ type: "input_text", text: instructions })); } catch {}
    }
    return;
  }

  const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(MODEL_NAME)}&voice=${encodeURIComponent(openaiVoice)}`;
  console.log("🔌 connecting to OpenAI realtime WS:", url);

  openaiWs = new WebSocket(url, {
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" }
  });
  openaiWs.binaryType = "arraybuffer";

  openaiWs.on("open", () => {
    console.log("✅ Connected to OpenAI Realtime WS");
    openaiReady = true;
    if (openaiInstructions) {
      try { openaiWs.send(JSON.stringify({ type: "input_text", text: openaiInstructions })); } catch {}
    }
  });

  openaiWs.on("message", (data) => {
    try {
      // Binary frames -> forward as base64 to clients
      if (typeof data !== "string" && Buffer.isBuffer(data)) {
        const base64 = data.toString("base64");
        broadcastToClients(JSON.stringify({ type: "output_audio_binary", data: base64 }));
        return;
      }
      // Text frames -> JSON -> forward
      const msg = JSON.parse(data.toString());
      broadcastToClients(JSON.stringify(msg));
    } catch (e) {
      console.warn("OpenAI message parse error:", e?.message || e);
    }
  });

  openaiWs.on("close", (code, reason) => {
    console.warn("⚠️ OpenAI WS closed:", code, safeStringifyReason(reason).slice(0, 200));
    openaiReady = false;
    // Reconnect after short delay
    setTimeout(() => connectOpenAI(openaiInstructions, openaiVoice), 2000);
  });

  openaiWs.on("error", (err) => {
    console.error("❌ OpenAI WS error:", err?.message || err);
    openaiReady = false;
  });
}

// initial background connection (no instr)
connectOpenAI("", DEFAULT_VOICE);

/* ---------- Browser WebSocket server (path /ws) ---------- */
const clients = new Set();
function broadcastToClients(msg) {
  for (const c of clients) {
    try {
      if (c.readyState === WebSocket.OPEN) c.send(msg);
    } catch {}
  }
}

wss.on("connection", (ws) => {
  console.log("🖥 Browser connected");
  clients.add(ws);

  ws.on("message", async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (!msg?.type) return;

      // INIT: build kundli and instruct OpenAI
      if (msg.type === "init") {
        const { name, dob, tob, pob, gender, voice } = msg;
        const kundli = await buildKundliSummary({ name, dob, tob, pob, gender });
        const instr = `You are Sumit Aggarwal, an experienced Vedic astrologer. Kundli summary: ${kundli}. Answer in Hindi, speak naturally and clearly.`;
        connectOpenAI(instr, (VALID_VOICES.includes(voice) ? voice : DEFAULT_VOICE));
        try { ws.send(JSON.stringify({ type: "init_ok" })); } catch {}
        return;
      }

      // MEDIA chunk from browser: base64 PCM16 LE
      if (msg.type === "media" && openaiReady) {
        try { openaiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: msg.data })); } catch (e) {}
        return;
      }

      // COMMIT: commit and ask for response
      if (msg.type === "media_commit" && openaiReady) {
        try {
          openaiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
          openaiWs.send(JSON.stringify({ type: "response.create", response: { instructions: "" } }));
        } catch (e) {}
        return;
      }

      // STOP
      if (msg.type === "stop") {
        try { ws.close(); } catch {}
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

/* ---------- Auto-clean old files (mp3/wav/tmp) ---------- */
function cleanOldFiles() {
  const dirs = [path.join(__dirname, "../public"), path.join(__dirname)];
  const now = Date.now();
  dirs.forEach(d => {
    if (!fs.existsSync(d)) return;
    fs.readdirSync(d).forEach(f => {
      if (/\.(mp3|wav|tmp)$/i.test(f)) {
        const fp = path.join(d, f);
        try {
          const st = fs.statSync(fp);
          if (now - st.mtimeMs > 5 * 60 * 1000) {
            fs.unlinkSync(fp);
            console.log("🧹 Deleted old file:", fp);
          }
        } catch (e) {}
      }
    });
  });
}
setInterval(cleanOldFiles, 5 * 60 * 1000);

/* ---------- Keep-alive (safe) ---------- */
setInterval(() => {
  try {
    const base = process.env.RENDER_EXTERNAL_URL || process.env.KEEP_ALIVE_URL || "";
    if (base && base.startsWith("http")) fetch(base).catch(() => {});
  } catch {}
}, 30000);

/* ---------- Start server ---------- */
server.listen(PORT, () => {
  console.log(`🚀 AstroOne WS server running on port ${PORT}`);
});
