// server/ws-server.js
// ==============================================
// AstroOne — FINAL Stable Build (Render Ready)
// Features:
// - Serves client/index_ws.html
// - Keeps persistent OpenAI Realtime WebSocket
// - Sends kundli summary via Shivam + Google Geocode
// - Auto deletes old audio/temp files every 5 min
// - Forward audio both ways (mic → OpenAI → voice back)
// ==============================================

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

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL_NAME = process.env.MODEL_NAME || "gpt-4o-realtime-preview-2024-10-01";
const DEFAULT_VOICE = process.env.DEFAULT_VOICE || "verse";
const GEOCODE_KEY = process.env.GEOCODE_KEY || "";
const SHIVAM_BASE = process.env.SHIVAM_BASE || "";
const SHIVAM_API_KEY = process.env.SHIVAM_API_KEY || "";

if (!OPENAI_API_KEY) {
  console.error("❌ Missing OPENAI_API_KEY");
  process.exit(1);
}

const VALID_VOICES = ["alloy","ash","ballad","coral","echo","sage","shimmer","verse","marin","cedar"];

const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "../client")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../client/index_ws.html"));
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

// =============== Helper functions ===================

async function geocodePlace(place) {
  if (!GEOCODE_KEY || !place) return { lat: null, lon: null };
  try {
    const res = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(place)}&key=${GEOCODE_KEY}`);
    const j = await res.json();
    if (j.status === "OK" && j.results.length) {
      const { lat, lng } = j.results[0].geometry.location;
      return { lat, lon: lng };
    }
  } catch (e) {
    console.warn("Geocode error:", e.message);
  }
  return { lat: null, lon: null };
}

async function fetchShivamKundli(name, dob, tob, pob, gender) {
  if (!SHIVAM_BASE || !SHIVAM_API_KEY) return null;
  try {
    const tokenRes = await fetch(`${SHIVAM_BASE}/users/generateToken`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apikey: SHIVAM_API_KEY }),
    });
    const tjson = await tokenRes.json().catch(()=>null);
    const token = tjson?.data?.[0]?.token;
    if (!token) return null;

    const [year,month,day] = dob.split("-");
    const [hour,min] = tob.split(":");
    const payload = { name, day, month, year, hour, min, place:pob, latitude:"", longitude:"", timezone:"5.5", gender:(gender||"male").toLowerCase() };

    const astroRes = await fetch(`${SHIVAM_BASE}/astro/getAstroData`, {
      method: "POST",
      headers: { Authorization:`Bearer ${token}`, "Content-Type":"application/json" },
      body: JSON.stringify(payload)
    });
    const ajson = await astroRes.json().catch(()=>null);
    return ajson?.data || null;
  } catch(e){ console.warn("Shivam error", e.message); return null; }
}

async function buildKundliSummary({ name, dob, tob, pob, gender }) {
  let summary = `नाम: ${name}, DOB: ${dob} ${tob}, POB: ${pob}`;
  try {
    const geo = await geocodePlace(pob);
    summary += ` (lat:${geo.lat||"NA"}, lon:${geo.lon||"NA"})`;
    const astro = await fetchShivamKundli(name, dob, tob, pob, gender);
    if (astro) summary += ` | Sun:${astro.sun_sign||""}, Moon:${astro.moon_sign||""}`;
  } catch {}
  return summary;
}

// =============== OpenAI Realtime ===================

let openaiWs = null;
let openaiReady = false;
let openaiVoice = DEFAULT_VOICE;
let openaiInstructions = "";

function connectOpenAI(instructions = "", voice = DEFAULT_VOICE) {
  if (!VALID_VOICES.includes(voice)) voice = DEFAULT_VOICE;
  openaiInstructions = instructions || openaiInstructions;
  openaiVoice = voice;

  if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
    if (instructions) openaiWs.send(JSON.stringify({ type: "input_text", text: instructions }));
    return;
  }

  const url = `wss://api.openai.com/v1/realtime?model=${MODEL_NAME}&voice=${voice}`;
  console.log("🔌 Connecting OpenAI Realtime:", url);
  openaiWs = new WebSocket(url, {
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" },
  });
  openaiWs.binaryType = "arraybuffer";

  openaiWs.on("open", () => {
    console.log("✅ Connected to OpenAI Realtime WS");
    openaiReady = true;
    if (openaiInstructions)
      openaiWs.send(JSON.stringify({ type: "input_text", text: openaiInstructions }));
  });

  openaiWs.on("message", (data) => {
    try {
      if (typeof data !== "string" && Buffer.isBuffer(data)) {
        const base64 = data.toString("base64");
        broadcast(JSON.stringify({ type:"output_audio_binary", data:base64 }));
        return;
      }
      const msg = JSON.parse(data.toString());
      broadcast(JSON.stringify(msg));
    } catch {}
  });

  openaiWs.on("close", (code, reason) => {
    console.warn("⚠️ OpenAI WS closed:", code);
    openaiReady = false;
    setTimeout(()=>connectOpenAI(openaiInstructions, openaiVoice),3000);
  });

  openaiWs.on("error", (err) => {
    console.error("OpenAI WS error:", err.message);
    openaiReady = false;
  });
}

connectOpenAI("", DEFAULT_VOICE);

// =============== WebSocket Server for Browser ===================

const clients = new Set();
function broadcast(msg){
  for (const ws of clients) if (ws.readyState === WebSocket.OPEN) ws.send(msg);
}

wss.on("connection", (ws) => {
  console.log("🖥 Browser connected");
  clients.add(ws);

  ws.on("message", async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "init") {
        const { name, dob, tob, pob, gender, voice } = msg;
        const kundli = await buildKundliSummary({ name, dob, tob, pob, gender });
        const instr = `You are Sumit Aggarwal, a professional Vedic astrologer. Kundli summary: ${kundli}. Speak in Hindi naturally.`;
        connectOpenAI(instr, voice);
        ws.send(JSON.stringify({ type:"init_ok" }));
        return;
      }
      if (msg.type === "media" && openaiReady)
        openaiWs.send(JSON.stringify({ type:"input_audio_buffer.append", audio: msg.data }));
      if (msg.type === "media_commit" && openaiReady){
        openaiWs.send(JSON.stringify({ type:"input_audio_buffer.commit" }));
        openaiWs.send(JSON.stringify({ type:"response.create", response:{instructions:"Respond in Hindi"}} ));
      }
      if (msg.type === "stop") ws.close();
    } catch(e){ console.warn("Browser msg err", e.message); }
  });

  ws.on("close", ()=>{clients.delete(ws);console.log("🖥 Browser disconnected");});
});

// =============== Auto Clean Temp Files ===================

function cleanOldFiles(){
  const dirs = [path.join(__dirname, "../public"), path.join(__dirname)];
  const now = Date.now();
  dirs.forEach(d=>{
    if (!fs.existsSync(d)) return;
    fs.readdirSync(d).forEach(f=>{
      if (f.endsWith(".mp3") || f.endsWith(".wav") || f.endsWith(".tmp")){
        const fp = path.join(d,f);
        try {
          const st = fs.statSync(fp);
          if (now - st.mtimeMs > 5*60*1000){ // older than 5 min
            fs.unlinkSync(fp);
            console.log("🧹 Deleted old file:", f);
          }
        } catch {}
      }
    });
  });
}
setInterval(cleanOldFiles, 5*60*1000);

// =============== Keep Alive Ping ===================
setInterval(()=>{
  try{
    const base = process.env.RENDER_EXTERNAL_URL || "";
    if(base.startsWith("http")) fetch(base).catch(()=>{});
  }catch{}
},30000);

// =============== Start Server ===================
server.listen(PORT, ()=>console.log(`🚀 AstroOne WS running on port ${PORT}`));
