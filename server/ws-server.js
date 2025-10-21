// server/ws-server.js
// AstroOne Realtime — Final Stable WebSocket Version (Continuous Talk)
// Compatible with OpenAI GPT-4o Realtime API (WebSocket mode)

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
const MODEL_NAME = process.env.MODEL_NAME || "gpt-4o-realtime-preview-2024-10-01";
const SHIVAM_BASE = process.env.SHIVAM_BASE;
const SHIVAM_API_KEY = process.env.SHIVAM_API_KEY;
const GEOCODE_KEY = process.env.GEOCODE_KEY || "";
const DEFAULT_VOICE = process.env.DEFAULT_VOICE || "verse";

// ✅ Valid voices as per current OpenAI Realtime API
const VALID_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar"];

const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "../client")));

if (!OPENAI_API_KEY) {
  console.error("❌ Missing OPENAI_API_KEY in environment!");
  process.exit(1);
}

// =====================================================
// 🔮 Helper: Fetch Kundli summary (Shivam API + Google)
// =====================================================
async function fetchKundliSummary({ name, dob, tob, pob, gender }) {
  const [year, month, day] = dob.split("-");
  const [hour, min] = tob.split(":");
  let lat = "28.6139", lon = "77.2090";

  // 🌍 Geocode using Google
  if (GEOCODE_KEY && pob) {
    try {
      const res = await fetch(
        `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(pob)}&key=${GEOCODE_KEY}`
      );
      const json = await res.json();
      if (json.status === "OK" && json.results?.length) {
        lat = String(json.results[0].geometry.location.lat);
        lon = String(json.results[0].geometry.location.lng);
      }
    } catch (e) {
      console.warn("⚠️ Geocode error:", e.message);
    }
  }

  let summary = `नाम: ${name}, DOB: ${dob} ${tob}, POB: ${pob} (lat:${lat}, lon:${lon})`;

  // 🪐 Call Shivam API if available
  if (SHIVAM_BASE && SHIVAM_API_KEY) {
    try {
      const tokenRes = await fetch(`${SHIVAM_BASE}/users/generateToken`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apikey: SHIVAM_API_KEY }),
      });
      const tokenJson = await tokenRes.json();
      const authToken = tokenJson?.data?.[0]?.token;
      if (authToken) {
        const payload = {
          name,
          day,
          month,
          year,
          hour,
          min,
          place: pob,
          latitude: lat,
          longitude: lon,
          timezone: "5.5",
          gender: (gender || "male").toLowerCase(),
        };
        const astroRes = await fetch(`${SHIVAM_BASE}/astro/getAstroData`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${authToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });
        const astroJson = await astroRes.json();
        const sun = astroJson?.data?.sun_sign || "";
        const moon = astroJson?.data?.moon_sign || "";
        summary += ` | Sun: ${sun}, Moon: ${moon}`;
      }
    } catch (e) {
      console.warn("⚠️ Shivam API error:", e.message);
    }
  }

  return summary;
}

// =====================================================
// 🌐 OpenAI Realtime WebSocket connection
// =====================================================
let openaiWs = null;
let openaiReady = false;

async function connectOpenAI(instructions = "", voice = DEFAULT_VOICE) {
  if (!VALID_VOICES.includes(voice)) voice = DEFAULT_VOICE;

  const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(MODEL_NAME)}&voice=${voice}`;
  console.log("🔌 Connecting OpenAI WS:", url);

  const headers = {
    Authorization: `Bearer ${OPENAI_API_KEY}`,
    "OpenAI-Beta": "realtime=v1",
  };

  openaiWs = new WebSocket(url, { headers });
  openaiWs.binaryType = "arraybuffer";

  openaiWs.on("open", () => {
    console.log("✅ Connected to OpenAI Realtime WS");
    openaiReady = true;
    if (instructions) {
      openaiWs.send(JSON.stringify({ type: "input_text", text: instructions }));
    }
  });

  openaiWs.on("message", (data) => {
    try {
      if (typeof data === "string") {
        const msg = JSON.parse(data);
        broadcast(JSON.stringify(msg));
      } else if (data instanceof Buffer) {
        // Binary audio frame
        const base64 = data.toString("base64");
        broadcast(JSON.stringify({ type: "output_audio_binary", data: base64 }));
      }
    } catch (err) {
      console.warn("Parse error:", err.message);
    }
  });

  openaiWs.on("close", () => {
    openaiReady = false;
    console.warn("⚠️ OpenAI WS closed — reconnecting in 3s...");
    setTimeout(() => connectOpenAI(instructions, voice), 3000);
  });

  openaiWs.on("error", (err) => {
    openaiReady = false;
    console.error("❌ OpenAI WS error:", err.message);
  });
}

// =====================================================
// 🧠 Local WS Server for Browser Clients
// =====================================================
const wss = new WebSocketServer({ port: 8080 });
console.log("🛰 Browser WebSocket server on ws://0.0.0.0:8080");

const clients = new Set();
function broadcast(msg) {
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

wss.on("connection", (ws) => {
  console.log("🖥️ Browser connected");
  clients.add(ws);

  ws.on("message", async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "init") {
        const { name, dob, tob, pob, gender, voice } = msg;
        const kundli = await fetchKundliSummary({ name, dob, tob, pob, gender });
        const instr = `You are Sumit Aggarwal, a professional Vedic astrologer. Kundli: ${kundli}. Speak in Hindi, naturally.`;
        await connectOpenAI(instr, voice);
        ws.send(JSON.stringify({ type: "init_ok" }));
      } else if (msg.type === "media") {
        if (openaiReady && msg.data) {
          openaiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: msg.data }));
        }
      } else if (msg.type === "media_commit") {
        if (openaiReady) {
          openaiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
          openaiWs.send(JSON.stringify({ type: "response.create", response: { instructions: "" } }));
        }
      } else if (msg.type === "stop") {
        ws.close();
      }
    } catch (e) {
      console.warn("⚠️ WS message error:", e.message);
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    console.log("🖥️ Browser disconnected");
  });
});

// =====================================================
// 🌐 Express Setup (serves client UI)
// =====================================================
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../client/index_ws.html"));
});

// Prevent Render from sleeping
setInterval(() => {
  fetch("https://astroone-realtime.onrender.com/").catch(() => {});
}, 30000);

app.listen(PORT, () => {
  console.log(`🚀 AstroOne WS Server running on port ${PORT}`);
});
