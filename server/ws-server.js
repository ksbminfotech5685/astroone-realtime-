// server/ws-server.js
// AstroOne — Final Stable Full Build (Render Ready)
// — Kundli + Google Geocode + OpenAI Realtime + Auto cleanup — //

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
const VALID_VOICES = ["alloy","ash","ballad","coral","echo","sage","shimmer","verse","marin","cedar"];

if (!OPENAI_API_KEY) {
  console.error("❌ OPENAI_API_KEY missing.");
  process.exit(1);
}

const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "../client")));
app.get("/", (req,res)=>res.sendFile(path.join(__dirname,"../client/index_ws.html")));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

// ---------- helpers ----------
async function geocodePlace(place){
  if(!GEOCODE_KEY||!place)return{lat:null,lon:null};
  try{
    const r=await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(place)}&key=${GEOCODE_KEY}`);
    const j=await r.json();
    if(j.status==="OK"&&j.results.length){
      const {lat,lng}=j.results[0].geometry.location;
      return{lat,lon:lng};
    }
  }catch(e){console.warn("Geo err",e.message);}
  return{lat:null,lon:null};
}

async function fetchShivamKundli(name,dob,tob,pob,gender){
  if(!SHIVAM_BASE||!SHIVAM_API_KEY)return null;
  try{
    const t=await fetch(`${SHIVAM_BASE}/users/generateToken`,{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({apikey:SHIVAM_API_KEY})
    });
    const tj=await t.json().catch(()=>null);
    const token=tj?.data?.[0]?.token; if(!token)return null;
    const [y,m,d]=dob.split("-");const [h,min]=tob.split(":");
    const p={name,day:d,month:m,year:y,hour:h,min,place:pob,latitude:"",longitude:"",timezone:"5.5",gender:(gender||"male").toLowerCase()};
    const a=await fetch(`${SHIVAM_BASE}/astro/getAstroData`,{
      method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify(p)
    });
    const aj=await a.json().catch(()=>null);
    return aj?.data||null;
  }catch(e){return null;}
}

async function buildKundliSummary({name,dob,tob,pob,gender}){
  let summary=`नाम: ${name}, DOB: ${dob} ${tob}, POB: ${pob}`;
  try{
    const geo=await geocodePlace(pob);
    summary+=` (lat:${geo.lat||"NA"},lon:${geo.lon||"NA"})`;
    const astro=await fetchShivamKundli(name,dob,tob,pob,gender);
    if(astro)summary+=` | Sun:${astro.sun_sign||""}, Moon:${astro.moon_sign||""}`;
  }catch{}
  return summary;
}

// ---------- OpenAI realtime ----------
let openaiWs=null,openaiReady=false,openaiVoice=DEFAULT_VOICE,openaiInstructions="";
function connectOpenAI(instr="",voice=DEFAULT_VOICE){
  if(!VALID_VOICES.includes(voice))voice=DEFAULT_VOICE;
  openaiInstructions=instr||openaiInstructions;openaiVoice=voice;
  if(openaiWs&&openaiWs.readyState===WebSocket.OPEN){
    if(instr)openaiWs.send(JSON.stringify({type:"input_text",text:instr}));
    return;
  }
  const url=`wss://api.openai.com/v1/realtime?model=${MODEL_NAME}&voice=${voice}`;
  console.log("🔌 connecting OpenAI:",url);
  openaiWs=new WebSocket(url,{headers:{Authorization:`Bearer ${OPENAI_API_KEY}`,"OpenAI-Beta":"realtime=v1"}});
  openaiWs.binaryType="arraybuffer";

  openaiWs.on("open",()=>{
    console.log("✅ Connected OpenAI Realtime");
    openaiReady=true;
    if(openaiInstructions)openaiWs.send(JSON.stringify({type:"input_text",text:openaiInstructions}));
  });

  openaiWs.on("message",(d)=>{
    if(typeof d!=="string"&&Buffer.isBuffer(d)){
      const b64=d.toString("base64");
      broadcast(JSON.stringify({type:"output_audio_binary",data:b64}));
      return;
    }
    try{broadcast(JSON.stringify(JSON.parse(d.toString())));}catch{}
  });

  openaiWs.on("close",(c)=>{console.warn("⚠️ OpenAI WS closed",c);openaiReady=false;setTimeout(()=>connectOpenAI(openaiInstructions,openaiVoice),2000);});
  openaiWs.on("error",(e)=>{console.error("OpenAI WS error",e.message);openaiReady=false;});
}
connectOpenAI("",DEFAULT_VOICE);

// ---------- browser WS ----------
const clients=new Set();
function broadcast(m){for(const c of clients)if(c.readyState===WebSocket.OPEN)c.send(m);}
wss.on("connection",(ws)=>{
  console.log("🖥 browser connected");clients.add(ws);
  ws.on("message",async(raw)=>{
    try{
      const msg=JSON.parse(raw.toString());
      if(msg.type==="init"){
        const {name,dob,tob,pob,gender,voice}=msg;
        const kundli=await buildKundliSummary({name,dob,tob,pob,gender});
        const instr=`You are Sumit Aggarwal, Vedic astrologer. Kundli: ${kundli}. Answer in Hindi voice.`;
        connectOpenAI(instr,voice);ws.send(JSON.stringify({type:"init_ok"}));return;
      }
      if(msg.type==="media"&&openaiReady)openaiWs.send(JSON.stringify({type:"input_audio_buffer.append",audio:msg.data}));
      if(msg.type==="media_commit"&&openaiReady){
        openaiWs.send(JSON.stringify({type:"input_audio_buffer.commit"}));
        openaiWs.send(JSON.stringify({type:"response.create",response:{instructions:""} }));
      }
      if(msg.type==="stop")ws.close();
    }catch(e){console.warn("WS msg err",e.message);}
  });
  ws.on("close",()=>{clients.delete(ws);console.log("🖥 disconnected");});
});

// ---------- auto cleanup ----------
function cleanOldFiles(){
  const dirs=[path.join(__dirname,"../public"),__dirname];
  const now=Date.now();
  dirs.forEach(d=>{
    if(!fs.existsSync(d))return;
    fs.readdirSync(d).forEach(f=>{
      if(/\.(mp3|wav|tmp)$/i.test(f)){
        const fp=path.join(d,f);
        try{
          const st=fs.statSync(fp);
          if(now-st.mtimeMs>5*60*1000){fs.unlinkSync(fp);console.log("🧹 deleted",f);}
        }catch{}
      }
    });
  });
}
setInterval(cleanOldFiles,5*60*1000);

// ---------- keep-alive ----------
setInterval(()=>{try{
  const base=process.env.RENDER_EXTERNAL_URL||"";
  if(base.startsWith("http"))fetch(base).catch(()=>{});
}catch{}},30000);

// ---------- start ----------
server.listen(PORT,()=>console.log(`🚀 AstroOne WS running on ${PORT}`));
