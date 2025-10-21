// server/ws-server.js
// AstroOne Final Working Version — Live Audio Realtime (Render compatible)

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

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL_NAME = process.env.MODEL_NAME || "gpt-4o-realtime-preview-2024-10-01";
const DEFAULT_VOICE = process.env.DEFAULT_VOICE || "verse";
const GEOCODE_KEY = process.env.GEOCODE_KEY || "";
const SHIVAM_BASE = process.env.SHIVAM_BASE || "";
const SHIVAM_API_KEY = process.env.SHIVAM_API_KEY || "";

const VALID_VOICES = ["alloy","ash","ballad","coral","echo","sage","shimmer","verse","marin","cedar"];

if (!OPENAI_API_KEY) {
  console.error("❌ OPENAI_API_KEY missing.");
  process.exit(1);
}

const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "../client")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../client/index_ws.html"));
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

let openaiWs = null;
let openaiReady = false;
let openaiConnected = false;

// -------------------------- Helper --------------------------
async function fetchKundliSummary({ name, dob, tob, pob, gender }) {
  try {
    let lat = "28.6139", lon = "77.2090";
    if (GEOCODE_KEY && pob) {
      const geo = await fetch(
        `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(pob)}&key=${GEOCODE_KEY}`
      );
      const gj = await geo.json();
      if (gj.status === "OK" && gj.results?.length) {
        lat = String(gj.results[0].geometry.location.lat);
        lon = String(gj.results[0].geometry.location.lng);
      }
    }
    let summary = `नाम: ${name}, DOB: ${dob} ${tob}, POB: ${pob} (lat:${lat}, lon:${lon})`;
    if (SHIVAM_BASE && SHIVAM_API_KEY) {
      try {
        const t = await fetch(`${SHIVAM_BASE}/users/generateToken`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ apikey: SHIVAM_API_KEY }),
        });
        const tjs = await t.json();
        const auth = tjs?.data?.[0]?.token;
        if (auth) {
          const [year,month,day] = dob.split("-");
          const [hour,min] = tob.split(":");
          const payload = { name, day, month, year, hour, min, place:pob, latitude:lat, longitude:lon, timezone:"5.5", gender:(gender||"male").toLowerCase() };
          const res = await fetch(`${SHIVAM_BASE}/astro/getAstroData`, {
            method:"POST",
            headers:{ Authorization:`Bearer ${auth}`, "Content-Type":"application/json" },
            body: JSON.stringify(payload)
          });
          const js = await res.json();
          summary += ` | Sun:${js?.data?.sun_sign||""}, Moon:${js?.data?.moon_sign||""}`;
        }
      } catch(e){}
    }
    return summary;
  } catch { return ""; }
}

// -------------------- Connect to OpenAI Realtime --------------------
function connectOpenAI(instructions = "", voice = DEFAULT_VOICE) {
  if (!VALID_VOICES.includes(voice)) voice = DEFAULT_VOICE;
  if (openaiConnected) return; // reuse one
  const url = `wss://api.openai.com/v1/realtime?model=${MODEL_NAME}&voice=${voice}`;
  console.log("🔌 Connecting to OpenAI Realtime:", url);
  openaiWs = new WebSocket(url, {
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" }
  });
  openaiWs.binaryType = "arraybuffer";

  openaiWs.on("open", () => {
    console.log("✅ Connected to OpenAI Realtime WS");
    openaiReady = true;
    openaiConnected = true;
    if (instructions) {
      openaiWs.send(JSON.stringify({ type: "input_text", text: instructions }));
    }
  });

  openaiWs.on("message", (data) => {
    if (typeof data !== "string") {
      const base64 = Buffer.from(data).toString("base64");
      broadcast(JSON.stringify({ type:"output_audio_binary", data:base64 }));
      return;
    }
    try {
      const msg = JSON.parse(data);
      broadcast(JSON.stringify(msg));
    } catch {}
  });

  openaiWs.on("close", (code, reason) => {
    console.warn("⚠️ OpenAI WS closed:", code);
    openaiReady = false;
    openaiConnected = false;
    setTimeout(() => connectOpenAI(instructions, voice), 3000);
  });

  openaiWs.on("error", (err) => {
    console.error("❌ OpenAI WS error:", err.message);
    openaiReady = false;
    openaiConnected = false;
  });
}

// --------------------- Browser WebSocket ---------------------
const clients = new Set();
function broadcast(msg) {
  for (const c of clients) if (c.readyState === WebSocket.OPEN) c.send(msg);
}

wss.on("connection", (ws) => {
  console.log("🖥 Browser connected");
  clients.add(ws);

  ws.on("message", async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "init") {
        const { name, dob, tob, pob, gender, voice } = msg;
        const kundli = await fetchKundliSummary({ name, dob, tob, pob, gender });
        const instr = `You are Sumit Aggarwal, a professional Vedic astrologer. Kundli summary: ${kundli}. Answer naturally in Hindi.`;
        connectOpenAI(instr, voice);
        ws.send(JSON.stringify({ type: "init_ok" }));
      } else if (msg.type === "media" && openaiReady) {
        openaiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: msg.data }));
      } else if (msg.type === "media_commit" && openaiReady) {
        openaiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        openaiWs.send(JSON.stringify({ type: "response.create", response:{ instructions:"Respond in Hindi" } }));
      } else if (msg.type === "stop") {
        ws.close();
      }
    } catch (e) {
      console.warn("⚠️ Browser WS message error:", e.message);
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    console.log("🖥 Browser disconnected");
  });
});

// ------------------- Keep Alive (safe) -------------------
setInterval(() => {
  try {
    const base = process.env.RENDER_EXTERNAL_URL || process.env.KEEP_ALIVE_URL || "";
    if (base && base.startsWith("http")) fetch(base).catch(()=>{});
  } catch {}
}, 30000);

// ------------------- Start -------------------
server.listen(PORT, () => {
  console.log(`🚀 AstroOne WS server running on port ${PORT}`);
});
