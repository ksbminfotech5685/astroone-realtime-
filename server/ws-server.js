// server/ws-server.js
// ✅ Final working version — includes audio commit + response trigger
// Works on Render, same port WebSocket, continuous audio streaming

import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import fetch from "node-fetch";
import dotenv from "dotenv";
import http from "http";
import bodyParser from "body-parser";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL_NAME = process.env.MODEL_NAME || "gpt-4o-realtime-preview-2024-10-01";
const DEFAULT_VOICE = process.env.DEFAULT_VOICE || "verse";

const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "../client")));

if (!OPENAI_API_KEY) {
  console.error("❌ Missing OPENAI_API_KEY!");
  process.exit(1);
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

let openaiWs = null;
let openaiReady = false;

async function connectOpenAI(instructions = "", voice = DEFAULT_VOICE) {
  const url = `wss://api.openai.com/v1/realtime?model=${MODEL_NAME}&voice=${voice}`;
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
    if (typeof data !== "string") {
      const base64 = Buffer.from(data).toString("base64");
      broadcast(JSON.stringify({ type: "output_audio_binary", data: base64 }));
      return;
    }
    try {
      const msg = JSON.parse(data);
      // Forward messages to browser
      broadcast(JSON.stringify(msg));
    } catch (e) {
      console.warn("⚠️ Parse error:", e.message);
    }
  });

  openaiWs.on("close", () => {
    openaiReady = false;
    console.warn("⚠️ OpenAI WS closed — reconnecting...");
    setTimeout(() => connectOpenAI(instructions, voice), 3000);
  });

  openaiWs.on("error", (err) => {
    console.error("❌ OpenAI WS error:", err.message);
  });
}

// 🧠 Browser WS logic
const clients = new Set();
function broadcast(msg) {
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

wss.on("connection", (ws) => {
  console.log("🖥 Browser connected");
  clients.add(ws);

  ws.on("message", async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "init") {
        const instructions = `You are Sumit Aggarwal, a Vedic astrologer. Speak in Hindi naturally.`;
        await connectOpenAI(instructions, msg.voice);
        ws.send(JSON.stringify({ type: "init_ok" }));
      } else if (msg.type === "media" && openaiReady) {
        // append audio chunk
        openaiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: msg.data }));
      } else if (msg.type === "media_commit" && openaiReady) {
        // commit audio & ask model to reply
        openaiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        openaiWs.send(JSON.stringify({ type: "response.create", response: { instructions: "" } }));
      } else if (msg.type === "stop") {
        ws.close();
      }
    } catch (e) {
      console.warn("⚠️ WS message error:", e.message);
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    console.log("🖥 Browser disconnected");
  });
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../client/index_ws.html"));
});

server.listen(PORT, () => {
  console.log(`🚀 AstroOne Realtime running on port ${PORT}`);
});
