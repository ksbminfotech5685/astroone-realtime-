// server/server.js
// AstroOne Realtime — Final Stable Version 3.3

import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import bodyParser from "body-parser";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "../client")));

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SHIVAM_BASE = process.env.SHIVAM_BASE;
const SHIVAM_API_KEY = process.env.SHIVAM_API_KEY;
const GEOCODE_KEY = process.env.GEOCODE_KEY || "";
const DEFAULT_VOICE = process.env.DEFAULT_VOICE || "verse";

if (!OPENAI_API_KEY) console.warn("⚠️ OPENAI_API_KEY missing!");

// ===== Helper: Fetch Kundli Data =====
async function fetchKundliSummary({ name, dob, tob, pob, gender }) {
  const [year, month, day] = dob.split("-");
  const [hour, min] = tob.split(":");
  let lat = "28.6139", lon = "77.2090";
  if (GEOCODE_KEY) {
    try {
      const gRes = await fetch(
        `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(pob)}&key=${GEOCODE_KEY}`
      );
      const gJson = await gRes.json();
      if (gJson.status === "OK" && gJson.results?.length) {
        lat = String(gJson.results[0].geometry.location.lat);
        lon = String(gJson.results[0].geometry.location.lng);
      }
    } catch {}
  }
  let summary = `नाम: ${name}, DOB: ${dob} ${tob}, POB: ${pob} (lat:${lat},lon:${lon})`;
  if (SHIVAM_BASE && SHIVAM_API_KEY) {
    try {
      const tokenRes = await fetch(`${SHIVAM_BASE}/users/generateToken`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apikey: SHIVAM_API_KEY })
      });
      const tokenJson = await tokenRes.json();
      const authToken = tokenJson?.data?.[0]?.token;
      const payload = { name, day, month, year, hour, min, place: pob, latitude: lat, longitude: lon, timezone: "5.5", gender: gender.toLowerCase() };
      const astro = await fetch(`${SHIVAM_BASE}/astro/getAstroData`, {
        method: "POST",
        headers: { Authorization: `Bearer ${authToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const astroJson = await astro.json();
      const sun = astroJson?.data?.sun_sign || "";
      const moon = astroJson?.data?.moon_sign || "";
      summary += ` | Sun: ${sun}, Moon: ${moon}`;
    } catch (e) { console.warn("Shivam API error:", e.message); }
  }
  return summary;
}

// ===== API: Create Ephemeral Realtime Session =====
app.post("/session", async (req, res) => {
  try {
    const { name, dob, tob, pob, gender, voice } = req.body || {};
    if (!name || !dob || !tob || !pob || !gender)
      return res.status(400).json({ error: "Missing required fields" });

    const summary = await fetchKundliSummary({ name, dob, tob, pob, gender });

    const payload = {
      model: "gpt-4o-realtime-preview",
      voice: voice || DEFAULT_VOICE,
      instructions: `You are an experienced Vedic astrologer named Sumit Aggarwal. Kundli summary: ${summary}. Answer in Hindi, clearly and naturally.`
    };

    const openaiResp = await fetch("https://api.openai.com/v1/realtime/sessions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const data = await openaiResp.json();
    if (!openaiResp.ok) {
      console.error("OpenAI session error:", data);
      return res.status(500).json({ error: "OpenAI session creation failed", details: data });
    }

    res.json({ ok: true, session: data, kundli_summary: summary });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../client/index.html"));
});

// ===== Keep-alive ping to prevent Render sleep =====
setInterval(() => {
  fetch("https://astroone-realtime.onrender.com/").catch(() => {});
}, 30000);

app.listen(PORT, () => console.log(`✅ AstroOne Realtime 3.3 running on port ${PORT}`));
