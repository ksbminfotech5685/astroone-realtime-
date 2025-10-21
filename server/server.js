// server/server.js
// Express server for AstroOne Realtime
// - /session : create ephemeral OpenAI Realtime session (injects Kundli summary via Shivam)
// Note: adapt small fields if your OpenAI account expects different session payload shape.

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
app.use(express.static(path.join(__dirname, "../client"))); // serve client files
const PORT = process.env.PORT || 3000;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SHIVAM_BASE = process.env.SHIVAM_BASE;
const SHIVAM_API_KEY = process.env.SHIVAM_API_KEY;
const GEOCODE_KEY = process.env.GEOCODE_KEY || "";
const DEFAULT_VOICE = process.env.DEFAULT_VOICE || "verse";

if (!OPENAI_API_KEY) console.warn("⚠️ OPENAI_API_KEY missing. Add to .env or Render env.");

async function fetchKundliSummary({ name, dob, tob, pob, gender }) {
  // Convert date/time
  const [year, month, day] = dob.split("-");
  const [hour, min] = tob.split(":");

  // Geocode POB (best-effort)
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
    } catch (e) {
      console.warn("Geocode error:", e.message);
    }
  }

  // Call Shivam API to get astro data
  if (!SHIVAM_BASE || !SHIVAM_API_KEY) {
    console.warn("⚠️ Shivam not configured; returning basic summary.");
    return { summary: `नाम: ${name}, DOB: ${dob} ${tob}, POB: ${pob} (lat:${lat},lon:${lon})`, astroRaw: null };
  }

  // Get Shivam token
  const tokenRes = await fetch(`${SHIVAM_BASE}/users/generateToken`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apikey: SHIVAM_API_KEY })
  });
  const tokenJson = await tokenRes.json();
  const authToken = tokenJson?.data?.[0]?.token;
  if (!authToken) {
    console.warn("Shivam token missing; returning basic summary");
    return { summary: `नाम: ${name}, DOB: ${dob} ${tob}, POB: ${pob} (lat:${lat},lon:${lon})`, astroRaw: null };
  }

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
    gender: (gender || "male").toLowerCase()
  };

  const astroResp = await fetch(`${SHIVAM_BASE}/astro/getAstroData`, {
    method: "POST",
    headers: { Authorization: `Bearer ${authToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const astroJson = await astroResp.json().catch(() => null);

  // Build short human-readable summary from astroJson if available
  let summary = `नाम: ${name}, DOB: ${dob} ${tob}, POB: ${pob} (lat:${lat},lon:${lon})`;
  try {
    if (astroJson && astroJson.data) {
      // pick a few meaningful fields if present (adjust per actual Shivam response)
      const sun = astroJson.data.sun_sign || astroJson.data.sun || "";
      const moon = astroJson.data.moon_sign || "";
      summary += `; Sun: ${sun} Moon: ${moon}`;
    }
  } catch (e) {}

  return { summary, astroRaw: astroJson };
}

// Create ephemeral OpenAI Realtime session and return session JSON to client
// This endpoint receives birth details, builds kundli summary, and creates the realtime session.
app.post("/session", async (req, res) => {
  try {
    const { name, dob, tob, pob, gender, voice } = req.body || {};
    if (!name || !dob || !tob || !pob || !gender) {
      return res.status(400).json({ error: "Missing required fields: name,dob,tob,pob,gender" });
    }

    // 1) build kundli summary
    const { summary } = await fetchKundliSummary({ name, dob, tob, pob, gender });

    // 2) create ephemeral realtime session at OpenAI
    // NOTE: The Realtime Sessions API can vary; this body is the commonly used form.
    // If your account expects slightly different field names, adjust accordingly.
    const createPayload = {
      model: "gpt-4o-realtime-preview", // change to the exact model string your OpenAI account supports
      voice: voice || DEFAULT_VOICE,
      instructions: `You are an experienced Vedic astrologer named Sumit Aggarwal. Kundli summary: ${summary}. Answer politely in Hindi.`
    };

    const openaiResp = await fetch("https://api.openai.com/v1/realtime/sessions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(createPayload)
    });

    if (!openaiResp.ok) {
      const txt = await openaiResp.text();
      console.error("OpenAI create session failed:", openaiResp.status, txt);
      return res.status(500).json({ error: "OpenAI session creation failed", details: txt });
    }

    const sessionJson = await openaiResp.json();
    // sessionJson usually contains ephemeral client secret (client_secret.value) and session id and other metadata.
    res.json({ ok: true, session: sessionJson, kundli_summary: summary });
  } catch (err) {
    console.error("Session error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../client/index.html"));
});

app.listen(PORT, () => {
  console.log(`Realtime server listening on port ${PORT}`);
});
