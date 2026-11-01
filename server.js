
import express from "express";
import cors from "cors";
import multer from "multer";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import OpenAI from "openai";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 10000;

const DATA_DIR = path.join(os.tmpdir(), "burmese-ai-recap");
const VIDEO_DIR = path.join(DATA_DIR, "videos");
const AUDIO_DIR = path.join(DATA_DIR, "audio");
const FRAME_DIR = path.join(DATA_DIR, "frames");
const OUTPUT_DIR = path.join(DATA_DIR, "output");
const TEMP_DIR = path.join(DATA_DIR, "temp");

for (const dir of [
  DATA_DIR,
  VIDEO_DIR,
  AUDIO_DIR,
  FRAME_DIR,
  OUTPUT_DIR,
  TEMP_DIR
]) {
  fs.mkdirSync(dir, { recursive: true });
}

if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);
if (ffprobeStatic?.path) {
  ffmpeg.setFfprobePath(ffprobeStatic.path);
}

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

const jobs = new Map();
const videos = new Map();
const audioFiles = new Map();

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use("/media", express.static(DATA_DIR));

const MAX_FILE_SIZE =
  Number(process.env.MAX_FILE_SIZE) || 1024 * 1024 * 1024;

const MAX_VIDEO_DURATION =
  Number(process.env.MAX_VIDEO_DURATION) || 350 * 60;

const TEXT_MODEL =
  process.env.OPENAI_TEXT_MODEL || "gpt-4.1-mini";

const TRANSCRIBE_MODEL =
  process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe";

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, VIDEO_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || ".mp4";
    cb(null, `${uuidv4()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: MAX_FILE_SIZE
  }
});

function updateJob(id, data) {
  const old = jobs.get(id) || {};
  jobs.set(id, {
    ...old,
    ...data,
    updatedAt: new Date().toISOString()
  });
}

function getJob(id) {
  return jobs.get(id) || null;
}

function publicFileUrl(req, folder, filename) {
  return `${req.protocol}://${req.get("host")}/media/${folder}/${encodeURIComponent(filename)}`;
}

function ffprobe(file) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(file, (err, metadata) => {
      if (err) return reject(err);
      resolve(metadata);
    });
  });
}

function runFfmpeg(command) {
  return new Promise((resolve, reject) => {
    command
      .on("end", resolve)
      .on("error", reject)
      .run();
  });
}

function safeUnlink(file) {
  try {
    if (file && fs.existsSync(file)) fs.unlinkSync(file);
  } catch {}
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function getVoice(voice) {
  return voice === "female"
    ? "my-MM-NilarNeural"
    : "my-MM-ThihaNeural";
}

async function azureTTS(text, voice = "female") {
  const key = process.env.AZURE_SPEECH_KEY;
  const region = process.env.AZURE_SPEECH_REGION;

  if (!key || !region) {
    throw new Error("Azure Speech API Key သို့မဟုတ် Region မရှိသေးပါ။");
  }

  const ssml = `
    <speak version="1.0"
      xmlns="http://www.w3.org/2001/10/synthesis"
      xml:lang="my-MM">
      <voice name="${getVoice(voice)}">
        ${escapeXml(text)}
      </voice>
    </speak>
  `;

  const endpoint =
    `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": key,
      "Content-Type": "application/ssml+xml",
      "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
      "User-Agent": "BurmeseAIRecap"
    },
    body: ssml
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Azure TTS Error ${response.status}: ${detail}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

async function extractAudioChunks(videoPath, jobId) {
  const metadata = await ffprobe(videoPath);
  const duration = metadata.format.duration;

  if (!duration || duration > MAX_VIDEO_DURATION) {
    throw new Error("ဗီဒီယိုအရှည်ကို သတ်မှတ်ထားတဲ့ Limit အတွင်း စစ်ဆေးပေးပါ။");
  }

  const audioStream = metadata.streams.find(
    stream => stream.codec_type === "audio"
  );

  if (!audioStream) {
    throw new Error("ဒီဗီဒီယိုမှာ အသံ Track မတွေ့ပါ။");
  }

  const chunkSeconds = 480;
  const totalChunks = Math.ceil(duration / chunkSeconds);
  const chunks = [];

  for (let i = 0; i < totalChunks; i++) {
    const start = i * chunkSeconds;
    const output = path.join(
      TEMP_DIR,
      `${jobId}-audio-${i}.mp3`
    );

    await runFfmpeg(
      ffmpeg(videoPath)
        .setStartTime(start)
        .duration(Math.min(chunkSeconds, duration - start))
        .noVideo()
        .audioCodec("libmp3lame")
        .audioBitrate("64k")
        .output(output)
    );

    chunks.push(output);

    updateJob(jobId, {
      stage: "transcribing",
      progress: Math.round(((i + 1) / totalChunks) * 35),
      message: `အသံအပိုင်း ${i + 1}/${totalChunks} ကို ပြင်ဆင်ပြီးပါပြီ`
    });
  }

  return { chunks, duration };
}

async function transcribeChunks(chunks, jobId) {
  if (!openai) {
    throw new Error("OPENAI_API_KEY မရှိသေးပါ။");
  }

  const transcripts = [];

  for (let i = 0; i < chunks.length; i++) {
    const file = chunks[i];

    updateJob(jobId, {
      stage: "transcribing",
      progress: 35 + Math.round(((i + 1) / chunks.length) * 25),
      message: `အသံကို စာသားပြောင်းနေပါတယ် (${i + 1}/${chunks.length})`
    });

    const result = await openai.audio.transcriptions.create({
      file: fs.createReadStream(file),
      model: TRANSCRIBE_MODEL,
      language: "my"
    });

    transcripts.push(result.text || "");
    safeUnlink(file);
  }

  return transcripts.join("\n");
}

async function createRecap(transcript, style = "detailed") {
  if (!openai) {
    throw new Error("OPENAI_API_KEY မရှိသေးပါ။");
  }

  const styleInstruction = style === "short"
    ? "အဓိကဖြစ်ရပ်များကိုသာ ရွေးပြီး အတိုချုပ်ရေးပါ။"
    : style === "detailed"
      ? "အရေးကြီးသောဖြစ်ရပ်များ၊ စကားပြောခန်းများနှင့် အကြောင်းအရာအသေးစိတ်များကို ထိန်းသိမ်းပါ။"
      : "မူရင်းအကြောင်းအရာကို အသေးစိတ်ထိန်းသိမ်းပြီး မလိုအပ်သော ထပ်နေမှုများကိုသာ လျှော့ချပါ။";

  const response = await openai.chat.completions.create({
    model: TEXT_MODEL,
    temperature: 0.4,
    messages: [
      {
        role: "system",
        content: `
သင်သည် မြန်မာဘာသာ Video Recap Script ရေးသားသူဖြစ်သည်။

စည်းမျဉ်းများ -
1. မူရင်းဖြစ်ရပ်အစဉ်အတိုင်း ရေးပါ။
2. အရေးကြီးသောအချက်များ မချန်ထားပါနှင့်။
3. အရေးကြီးသော စကားပြောခန်းများနှင့် အပြန်အလှန်ပြောဆိုမှုများကို ထိန်းသိမ်းပါ။
4. မူရင်းထဲတွင် မပါသော အဖြစ်အပျက်များ မတီထွင်ပါနှင့်။
5. သဘာဝကျသော မြန်မာစကားပြောပုံစံဖြင့် ရေးပါ။
6. အလွန်အကျွံ အတိုချုံ့ခြင်း မလုပ်ပါနှင့်။
7. အသံဖတ်ရန် အဆင်ပြေသော စာကြောင်းများဖြင့် ရေးပါ။
        `
      },
      {
        role: "user",
        content: `
Recap ပုံစံ: ${styleInstruction}

အောက်ပါ စာသားကို မြန်မာ Video Recap Script အဖြစ် ပြောင်းရေးပါ။

${transcript}
        `
      }
    ]
  });

  return response.choices?.[0]?.message?.content?.trim() || "";
}

// Health
app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    status: "OK",
    service: "Burmese AI Recap Backend",
    version: "1.0.0",
    ffmpeg: Boolean(ffmpegPath),
    time: new Date().toISOString()
  });
});

// API connection status
app.get("/api/connections", async (req, res) => {
  const result = {
    server: true,
    ffmpeg: Boolean(ffmpegPath),
    openai: false,
    azure: false
  };

  if (openai) {
    try {
      await openai.models.list();
      result.openai = true;
    } catch {
      result.openai = false;
    }
  }

  if (
    process.env.AZURE_SPEECH_KEY &&
    process.env.AZURE_SPEECH_REGION
  ) {
    result.azure = true;
  }

  res.json({
    success: true,
    connections: result
  });
});

// Upload
app.post("/api/upload", upload.single("video"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Video ဖိုင် မရွေးချယ်ရသေးပါ။"
      });
    }

    const metadata = await ffprobe(req.file.path);
    const duration = metadata.format.duration || 0;

    if (duration > MAX_VIDEO_DURATION) {
      safeUnlink(req.file.path);
      return res.status(400).json({
        success: false,
        message: "ဗီဒီယိုအရှည် 350 မိနစ်ထက် ကျော်နေပါတယ်။"
      });
    }

    const id = uuidv4();

    const video = {
      id,
      name: req.file.originalname,
      path: req.file.path,
      size: req.file.size,
      duration,
      mimetype: req.file.mimetype
    };

    videos.set(id, video);

    res.json({
      success: true,
      video: {
        id,
        name: video.name,
        size: video.size,
        duration,
        previewUrl: publicFileUrl(req, "videos", path.basename(video.path))
      },
      message: "Video Upload အောင်မြင်ပါပြီ။"
    });
  } catch (error) {
    if (req.file) safeUnlink(req.file.path);

    res.status(400).json({
      success: false,
      message: error.message || "Video ကို ဖတ်လို့မရပါ။"
    });
  }
});

// AI Recap
app.post("/api/recap", async (req, res) => {
  const { videoId, style = "detailed" } = req.body || {};
  const video = videos.get(videoId);

  if (!video) {
    return res.status(404).json({
      success: false,
      message: "Video မတွေ့ပါ။ ပြန် Upload လုပ်ပေးပါ။"
    });
  }

  if (!openai) {
    return res.status(503).json({
      success: false,
      message: "OpenAI API Key မထည့်ရသေးပါ။"
    });
  }

  const jobId = uuidv4();

  updateJob(jobId, {
    id: jobId,
    videoId,
    stage: "starting",
    progress: 0,
    message: "AI Recap စတင်နေပါတယ်။",
    status: "processing"
  });

  res.json({
    success: true,
    jobId,
    message: "AI Recap စတင်ပါပြီ။"
  });

  (async () => {
    try {
      updateJob(jobId, {
        stage: "extracting",
        progress: 5,
        message: "Video ထဲက အသံကို ခွဲထုတ်နေပါတယ်။"
      });

      const { chunks } = await extractAudioChunks(video.path, jobId);

      const transcript = await transcribeChunks(chunks, jobId);

      updateJob(jobId, {
        stage: "writing",
        progress: 70,
        message: "AI က Recap Script ရေးနေပါတယ်။"
      });

      const recap = await createRecap(transcript, style);

      updateJob(jobId, {
        stage: "completed",
        progress: 100,
        status: "completed",
        message: "Recap Script ပြီးပါပြီ။",
        transcript,
        recap
      });
    } catch (error) {
      updateJob(jobId, {
        stage: "error",
        status: "failed",
        message: error.message || "Recap လုပ်ရာတွင် Error ဖြစ်သွားပါတယ်။"
      });
    }
  })();
});

// Job status
app.get("/api/jobs/:jobId", (req, res) => {
  const job = getJob(req.params.jobId);

  if (!job) {
    return res.status(404).json({
      success: false,
      message: "Job မတွေ့ပါ။"
    });
  }

  res.json({
    success: true,
    job
  });
});

// Burmese TTS
app.post("/api/tts", async (req, res) => {
  try {
    const { text, voice = "female" } = req.body || {};

    if (!text || !String(text).trim()) {
      return res.status(400).json({
        success: false,
        message: "အသံထုတ်မယ့် စာသား မရှိသေးပါ။"
      });
    }

    if (String(text).length > 12000) {
      return res.status(400).json({
        success: false,
        message: "စာသားအလွန်ရှည်နေပါတယ်။ အပိုင်းခွဲပေးပါ။"
      });
    }

    const audio = await azureTTS(text, voice);
    const id = uuidv4();
    const filename = `${id}.mp3`;
    const output = path.join(AUDIO_DIR, filename);

    fs.writeFileSync(output, audio);

    audioFiles.set(id, output);

    res.json({
      success: true,
      audioId: id,
      audioUrl: publicFileUrl(req, "audio", filename),
      message: "မြန်မာ AI အသံ ထုတ်ပြီးပါပြီ။"
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || "TTS Error"
    });
  }
});

// Extract one frame every 5 seconds
app.post("/api/keyframes", async (req, res) => {
  try {
    const { videoId } = req.body || {};
    const video = videos.get(videoId);

    if (!video) {
      return res.status(404).json({
        success: false,
        message: "Video မတွေ့ပါ။"
      });
    }

    const frameId = uuidv4();
    const folder = path.join(FRAME_DIR, frameId);
    fs.mkdirSync(folder, { recursive: true });

    const outputPattern = path.join(folder, "frame-%04d.jpg");

    await runFfmpeg(
      ffmpeg(video.path)
        .outputOptions([
          "-vf",
          "fps=1/5,scale=480:-2"
        ])
        .output(outputPattern)
    );

    const files = fs.readdirSync(folder)
      .filter(name => name.endsWith(".jpg"))
      .sort();

    const frames = files.map((name, index) => ({
      index,
      timeSeconds: index * 5,
      url: publicFileUrl(
        req,
        `frames/${frameId}`,
        name
      )
    }));

    res.json({
      success: true,
      intervalSeconds: 5,
      totalFrames: frames.length,
      frames
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || "Keyframe ထုတ်မရပါ။"
    });
  }
});

// Render MP4 with narration
app.post("/api/render", async (req, res) => {
  try {
    const {
      videoId,
      audioId,
      quality = "720p"
    } = req.body || {};

    const video = videos.get(videoId);
    const audioPath = audioFiles.get(audioId);

    if (!video || !audioPath || !fs.existsSync(audioPath)) {
      return res.status(400).json({
        success: false,
        message: "Video သို့မဟုတ် Audio ဖိုင် မတွေ့ပါ။"
      });
    }

    const metadata = await ffprobe(video.path);
    const duration = metadata.format.duration;

    const outputId = uuidv4();
    const filename = `${outputId}.mp4`;
    const outputPath = path.join(OUTPUT_DIR, filename);

    const qualityMap = {
      "480p": "854x480",
      "720p": "1280x720",
      "1080p": "1920x1080"
    };

    const resolution = qualityMap[quality] || qualityMap["720p"];

    const command = ffmpeg()
      .input(video.path)
      .input(audioPath)
      .complexFilter([
        `[1:a]apad,volume=1.0[narration]`
      ])
      .outputOptions([
        "-map 0:v:0",
        "-map [narration]",
        "-c:v libx264",
        "-preset veryfast",
        "-crf 23",
        `-vf scale=${resolution}:force_original_aspect_ratio=decrease,pad=${resolution}:(ow-iw)/2:(oh-ih)/2`,
        "-c:a aac",
        "-b:a 192k",
        "-t " + duration,
        "-movflags +faststart"
      ])
      .output(outputPath);

    await runFfmpeg(command);

    res.json({
      success: true,
      outputId,
      filename,
      downloadUrl: publicFileUrl(req, "output", filename),
      previewUrl: publicFileUrl(req, "output", filename),
      message: "MP4 Render ပြီးပါပြီ။"
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || "Video Render မအောင်မြင်ပါ။"
    });
  }
});

// Download
app.get("/api/download/:filename", (req, res) => {
  const filename = path.basename(req.params.filename);
  const file = path.join(OUTPUT_DIR, filename);

  if (!fs.existsSync(file)) {
    return res.status(404).json({
      success: false,
      message: "Download ဖိုင် မတွေ့ပါ။"
    });
  }

  res.download(file);
});

// General error handler
app.use((error, req, res, next) => {
  console.error(error);

  if (error instanceof multer.MulterError) {
    return res.status(413).json({
      success: false,
      message: error.code === "LIMIT_FILE_SIZE"
        ? "Upload ဖိုင်အရွယ်အစား သတ်မှတ်ချက်ထက် ကျော်နေပါတယ်။"
        : error.message
    });
  }

  res.status(500).json({
    success: false,
    message: error.message || "Server Error"
  });
});

app.listen(PORT, () => {
  console.log(`Burmese AI Recap Server running on port ${PORT}`);
});
