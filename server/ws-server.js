// server/ws-server.js
// Final stable AstroOne realtime server (ESM)
// - Serves client/index_ws.html
// - WS endpoint /ws for browser
// - Connects to OpenAI realtime (binary frames forwarded as base64 with sampleRate)
// - Kundli + optional Google geocode + Shivam integration
// - Auto-cleanup for old .mp3/.wav/.tmp files
// - Keepalive + reconnect logic

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

const PORT = Number(process.env.PORT || 10000);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const MODEL_NAME = process.env.MODEL_NAME || "gpt-4o-realtime-preview-2024-10-01";
const DEFAULT_VOICE = process.env.DEFAULT_VOICE || "verse";
const GEOCODE_KEY = process.env.GEOCODE_KEY || "";
const SHIVAM_BASE = process.env.SHIVAM_BASE || "";
const SHIVAM_API_KEY = process.env.SHIVAM_API_KEY || "";

const VALID_VOICES = ["alloy","ash","ballad","coral","echo","sage","shimmer","verse","marin","cedar"];

if (!OPENAI_API_KEY) {
  console.error("❌ OPENAI_API_KEY required in environment");
  process.exit(1);
}

const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "../client")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "../client/index_ws.html")));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

// helper: geocode place -> lat/lon (optional)
async function geocodePlace(place) {
  if (!GEOCODE_KEY || !place) return { lat: null, lon: null };
  try {
    const res = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(place)}&key=${GEOCODE_KEY}`);
    const j = await res.json();
    if (j.status === "OK" && j.results?.length) {
      const { lat, lng } = j.results[0].geometry.location;
      return { lat: String(lat), lon: String(lng) };
    }
  } catch (e) {
    console.warn("Geocode error:", e?.message || e);
  }
  return { lat: null, lon: null };
}

// helper: call Shivam kundli API (optional)
async function fetchShivamKundli(name, dob, tob, pob, gender) {
  if (!SHIVAM_BASE || !SHIVAM_API_KEY) return null;
  try {
    const tokenResp = await fetch(`${SHIVAM_BASE}/users/generateToken`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ apikey: SHIVAM_API_KEY })
    });
    const tjson = await tokenResp.json().catch(()=>null);
    const token = tjson?.data?.[0]?.token;
    if (!token) return null;
    const [year,month,day] = (dob || "").split("-");
    const [hour,min] = (tob || "").split(":");
    const payload = { name, day, month, year, hour, min, place: pob, latitude: "", longitude: "", timezone: "5.5", gender: (gender||"male").toLowerCase() };
    const astroRes = await fetch(`${SHIVAM_BASE}/astro/getAstroData`, {
      method:"POST", headers: { Authorization:`Bearer ${token}`, "Content-Type":"application/json" }, body: JSON.stringify(payload)
    });
    const aj = await astroRes.json().catch(()=>null);
    return aj?.data || null;
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
      summary += ` (lat:${geo.lat||"NA"}, lon:${geo.lon||"NA"})`;
    }
    if (SHIVAM_BASE && SHIVAM_API_KEY && name && dob && tob) {
      const astro = await fetchShivamKundli(name, dob, tob, pob, gender);
      if (astro) summary += ` | Sun:${astro.sun_sign||astro?.sun||""}, Moon:${astro.moon_sign||astro?.moon||""}`;
    }
  } catch (e){ }
  return summary;
}

/* -------- OpenAI Realtime WS Management -------- */
let openaiWs = null;
let openaiReady = false;
let openaiVoice = DEFAULT_VOICE;
let openaiInstructions = "";

// Set sample rate we expect OpenAI voice frames to be sent as.
// Based on testing OpenAI realtime tends to stream PCM at 24000 Hz for voice models.
const OPENAI_AUDIO_SAMPLE_RATE = 24000;

function connectOpenAI(instructions = "", voice = DEFAULT_VOICE) {
  if (!VALID_VOICES.includes(voice)) voice = DEFAULT_VOICE;
  if (instructions) openaiInstructions = instructions;
  openaiVoice = voice;

  if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
    if (instructions) {
      try { openaiWs.send(JSON.stringify({ type: "input_text", text: instructions })); } catch {}
    }
    return;
  }

  const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(MODEL_NAME)}&voice=${encodeURIComponent(openaiVoice)}`;
  console.log("🔌 connecting to OpenAI Realtime:", url);

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
      // binary audio frames (ArrayBuffer) -> forward as base64 + sampleRate
      if (typeof data !== "string" && Buffer.isBuffer(data)) {
        const base64 = data.toString("base64");
        const payload = { type: "output_audio_binary", data: base64, sampleRate: OPENAI_AUDIO_SAMPLE_RATE };
        broadcastToClients(JSON.stringify(payload));
        return;
      }
      // otherwise text message
      const msg = JSON.parse(data.toString());
      broadcastToClients(JSON.stringify(msg));
    } catch (e) {
      console.warn("OpenAI message parse err:", e?.message || e);
    }
  });

  openaiWs.on("close", (code, reason) => {
    console.warn("⚠️ OpenAI WS closed:", code, (reason && reason.toString && reason.toString().slice(0,200)) || "");
    openaiReady = false;
    setTimeout(()=>connectOpenAI(openaiInstructions, openaiVoice), 2000);
  });

  openaiWs.on("error", (err) => {
    console.error("OpenAI WS error:", err?.message || err);
    openaiReady = false;
  });
}

// initial connection
connectOpenAI("", DEFAULT_VOICE);

/* -------- Browser WS Server (/ws) -------- */
const clients = new Set();
function broadcastToClients(msg) {
  for (const c of clients) {
    try { if (c.readyState === WebSocket.OPEN) c.send(msg); } catch {}
  }
}

wss.on("connection", (ws) => {
  console.log("🖥 Browser connected");
  clients.add(ws);

  ws.on("message", async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (!msg?.type) return;

      if (msg.type === "init") {
        const { name, dob, tob, pob, gender, voice } = msg;
        const kundli = await buildKundliSummary({ name, dob, tob, pob, gender });
        const instr = `You are Sumit Aggarwal, an experienced Vedic astrologer. Kundli summary: ${kundli}. Respond in Hindi, speak clearly and naturally.`;
        connectOpenAI(instr, (VALID_VOICES.includes(voice) ? voice : DEFAULT_VOICE));
        try { ws.send(JSON.stringify({ type: "init_ok" })); } catch {}
        return;
      }

      // incoming mic audio chunk (base64 PCM16LE) from browser
      if (msg.type === "media" && openaiReady) {
        try { openaiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: msg.data })); } catch (e) {}
        return;
      }

      // commit and ask response
      if (msg.type === "media_commit" && openaiReady) {
        try {
          openaiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
          openaiWs.send(JSON.stringify({ type: "response.create", response: { instructions: "" } }));
        } catch (e) {}
        return;
      }

      if (msg.type === "stop") { try { ws.close(); } catch {} return; }

    } catch (e) {
      console.warn("Browser WS parse err:", e?.message || e);
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

/* -------- Auto-clean old files (mp3/wav/tmp) -------- */
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

/* -------- Keep-alive ping (safe) -------- */
setInterval(() => {
  try {
    const base = process.env.RENDER_EXTERNAL_URL || "";
    if (base && base.startsWith("http")) fetch(base).catch(()=>{});
  } catch {}
}, 30000);

/* -------- Start server -------- */
server.listen(PORT, () => {
  console.log(`🚀 AstroOne WS server running on port ${PORT}`);
});
