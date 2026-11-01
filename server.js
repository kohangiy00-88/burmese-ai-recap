// server.js
import express from "express";
import cors from "cors";
import multer from "multer";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import OpenAI from "openai";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const app = express();
const PORT = process.env.PORT || 10000;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(os.tmpdir(), "burmese-ai-recap");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const OUTPUT_DIR = path.join(DATA_DIR, "outputs");

for (const dir of [DATA_DIR, UPLOAD_DIR, OUTPUT_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

app.use(cors());
app.use(express.json({ limit: "2mb" }));

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE || 1073741824);
const MAX_VIDEO_DURATION = Number(process.env.MAX_VIDEO_DURATION || 21000);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "") || ".mp4";
    cb(null, `${crypto.randomUUID()}${ext.toLowerCase()}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE }
});

const jobs = new Map();

function publicError(error) {
  return error?.message || "လုပ်ဆောင်မှု မအောင်မြင်ပါ။";
}

async function probeVideo(filePath) {
  const { stdout } = await execFileAsync(
    ffprobeStatic.path,
    [
      "-v", "error",
      "-show_entries", "format=duration,size:stream=codec_type,width,height",
      "-of", "json",
      filePath
    ],
    { maxBuffer: 10 * 1024 * 1024 }
  );

  const data = JSON.parse(stdout);
  const video = data.streams?.find(s => s.codec_type === "video");
  const audio = data.streams?.some(s => s.codec_type === "audio");

  if (!video) throw new Error("Video stream မတွေ့ပါ။");

  return {
    duration: Number(data.format?.duration || 0),
    size: Number(data.format?.size || 0),
    width: Number(video.width || 0),
    height: Number(video.height || 0),
    hasAudio: Boolean(audio)
  };
}

function getVideoPath(videoId) {
  if (!/^[a-f0-9-]{36}$/i.test(String(videoId || ""))) {
    throw new Error("Video ID မမှန်ပါ။");
  }

  const filePath = path.join(UPLOAD_DIR, `${videoId}.json`);
  if (!fs.existsSync(filePath)) throw new Error("Video ဖိုင်ကို မတွေ့ပါ။");

  const info = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!fs.existsSync(info.path)) throw new Error("Video ဖိုင် မရှိတော့ပါ။");
  return info;
}

async function makeAudioChunks(videoPath, workDir, duration) {
  const chunkSeconds = 480;
  const outputPattern = path.join(workDir, "audio-%03d.mp3");

  await execFileAsync(ffmpegPath, [
    "-y",
    "-i", videoPath,
    "-vn",
    "-ac", "1",
    "-ar", "16000",
    "-b:a", "48k",
    "-f", "segment",
    "-segment_time", String(chunkSeconds),
    "-reset_timestamps", "1",
    outputPattern
  ], { maxBuffer: 20 * 1024 * 1024 });

  const files = fs.readdirSync(workDir)
    .filter(name => /^audio-\d+\.mp3$/.test(name))
    .sort()
    .map(name => path.join(workDir, name));

  if (!files.length) throw new Error("အသံဖိုင် ထုတ်ယူလို့မရပါ။");

  return files.map((file, index) => ({
    file,
    offset: index * chunkSeconds
  }));
}

app.get("/api/health", (_req, res) => {
  res.json({
    success: true,
    status: "OK",
    service: "Burmese AI Recap",
    ffmpeg: Boolean(ffmpegPath),
    openaiConfigured: Boolean(openai),
    azureConfigured: Boolean(
      process.env.AZURE_SPEECH_KEY && process.env.AZURE_SPEECH_REGION
    )
  });
});

app.get("/api/connections", async (_req, res) => {
  const result = {
    openai: { configured: Boolean(openai), connected: false },
    azure: { configured: false, connected: false }
  };

  if (openai) {
    try {
      await openai.models.list();
      result.openai.connected = true;
    } catch (error) {
      result.openai.error = publicError(error);
    }
  }

  const azureKey = process.env.AZURE_SPEECH_KEY;
  const azureRegion = process.env.AZURE_SPEECH_REGION;

  result.azure.configured = Boolean(azureKey && azureRegion);

  if (result.azure.configured) {
    try {
      const response = await fetch(
        `https://${azureRegion}.tts.speech.microsoft.com/cognitiveservices/voices/list`,
        { headers: { "Ocp-Apim-Subscription-Key": azureKey } }
      );

      result.azure.connected = response.ok;
      if (!response.ok) {
        result.azure.error = `Azure HTTP ${response.status}`;
      } else {
        const voices = await response.json();
        result.azure.burmeseVoices = voices
          .filter(v => v.Locale === "my-MM")
          .map(v => v.ShortName);
      }
    } catch (error) {
      result.azure.error = publicError(error);
    }
  }

  res.json({ success: true, connections: result });
});

app.post("/api/upload", upload.single("video"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: "Video ဖိုင်ရွေးပါ။" });
    }

    const meta = await probeVideo(req.file.path);

    if (meta.duration > MAX_VIDEO_DURATION) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({
        success: false,
        message: "ဗီဒီယိုကြာချိန်က သတ်မှတ်ထားတဲ့ 350 မိနစ်ထက် ကျော်နေပါတယ်။"
      });
    }

    const videoId = crypto.randomUUID();
    const savedPath = path.join(UPLOAD_DIR, `${videoId}${path.extname(req.file.path)}`);
    fs.renameSync(req.file.path, savedPath);

    const info = {
      id: videoId,
      path: savedPath,
      originalName: req.file.originalname,
      ...meta
    };

    fs.writeFileSync(
      path.join(UPLOAD_DIR, `${videoId}.json`),
      JSON.stringify(info)
    );

    res.json({
      success: true,
      file: {
        id: videoId,
        name: info.originalName,
        duration: info.duration,
        size: info.size,
        width: info.width,
        height: info.height,
        hasAudio: info.hasAudio
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: publicError(error) });
  }
});

app.post("/api/recap", async (req, res) => {
  const workDir = path.join(DATA_DIR, crypto.randomUUID());
  fs.mkdirSync(workDir, { recursive: true });

  try {
    if (!openai) throw new Error("OPENAI_API_KEY မထည့်ရသေးပါ။");

    const info = getVideoPath(req.body.videoId);
    const style = String(req.body.style || "balanced");
    const chunks = await makeAudioChunks(info.path, workDir, info.duration);

    let transcript = "";

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const result = await openai.audio.transcriptions.create({
        file: fs.createReadStream(chunk.file),
        model: process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe",
        language: "my"
      });

      transcript += `\n[${Math.floor(chunk.offset / 60)} မိနစ်ခန့်မှ စတင်သောအပိုင်း]\n`;
      transcript += result.text || "";
    }

    if (!transcript.trim()) throw new Error("အသံထဲက စာသားကို မရရှိပါ။");

    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_TEXT_MODEL || "gpt-4.1-mini",
      temperature: 0.35,
      messages: [
        {
          role: "system",
          content:
            "သင်သည် မြန်မာဘာသာဖြင့် သဘာဝကျသော video recap ရေးသားသူဖြစ်သည်။ " +
            "ဇာတ်လမ်းအစဉ်လိုက်ကို မပြောင်းပါနှင့်။ အရေးကြီးသောဖြစ်ရပ်များ၊ " +
            "စကားပြောခန်းများနှင့် အကြောင်းရင်း/အကျိုးဆက်များကို မချန်ပါနှင့်။ " +
            "မရှိသောအချက်အလက်ကို မတီထွင်ပါနှင့်။ မြန်မာအသံဖတ်ရန် သင့်တော်သော " +
            "ပြောစကားပုံစံဖြင့် ရေးပါ။"
        },
        {
          role: "user",
          content:
            `Recap ပုံစံ: ${style}\n\n` +
            "အောက်ပါ Transcript ကို အခြေခံပြီး မြန်မာ Recap narration ရေးပါ။ " +
            "အရေးကြီးတဲ့ dialogue နဲ့ အချက်အလက်တွေကို ထိန်းထားပါ။\n\n" +
            transcript.slice(0, 90000)
        }
      ]
    });

    const recap = completion.choices?.[0]?.message?.content?.trim();

    res.json({
      success: true,
      transcript,
      recap,
      note: "ဤ Recap သည် Transcript အခြေခံ narration ဖြစ်ပြီး မူရင်းဗီဒီယိုမှ ဖြတ်တောက်မည့် အချိန်အပိုင်းများကို အလိုအလျောက် မရွေးချယ်ရသေးပါ။"
    });
  } catch (error) {
    res.status(500).json({ success: false, message: publicError(error) });
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

app.post("/api/tts", async (req, res) => {
  try {
    const key = process.env.AZURE_SPEECH_KEY;
    const region = process.env.AZURE_SPEECH_REGION;

    if (!key || !region) throw new Error("Azure Speech API Key / Region မပြည့်စုံပါ။");

    const text = String(req.body.text || "").trim();
    if (!text) throw new Error("ဖတ်ရန် စာသားထည့်ပါ။");
    if (text.length > 12000) throw new Error("စာသားအရှည် 12,000 characters ထက် မကျော်ရပါ။");

    const voice = req.body.voice === "female"
      ? "my-MM-NilarNeural"
      : "my-MM-ThihaNeural";

    const escaped = text
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&apos;");

    const ssml =
      `<speak version="1.0" xml:lang="my-MM">` +
      `<voice name="${voice}">${escaped}</voice></speak>`;

    const response = await fetch(
      `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`,
      {
        method: "POST",
        headers: {
          "Ocp-Apim-Subscription-Key": key,
          "Content-Type": "application/ssml+xml",
          "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3"
        },
        body: ssml
      }
    );

    if (!response.ok) {
      throw new Error(`Azure TTS error: HTTP ${response.status} ${await response.text()}`);
    }

    const audioBuffer = Buffer.from(await response.arrayBuffer());
    const filename = `${crypto.randomUUID()}.mp3`;
    const outputPath = path.join(OUTPUT_DIR, filename);

    fs.writeFileSync(outputPath, audioBuffer);

    res.json({
      success: true,
      audioUrl: `/api/download/${filename}`,
      filename
    });
  } catch (error) {
    res.status(500).json({ success: false, message: publicError(error) });
  }
});

app.post("/api/render", async (req, res) => {
  const workId = crypto.randomUUID();

  try {
    const info = getVideoPath(req.body.videoId);
    const audioName = path.basename(String(req.body.audioFilename || ""));
    const audioPath = audioName
      ? path.join(OUTPUT_DIR, audioName)
      : null;

    if (audioName && (!audioPath || !fs.existsSync(audioPath))) {
      throw new Error("မြန်မာ Voiceover ဖိုင်ကို မတွေ့ပါ။");
    }

    const quality = String(req.body.quality || "720p");
    const sizes = {
      "480p": [854, 480],
      "720p": [1280, 720],
      "1080p": [1920, 1080]
    };

    if (!sizes[quality]) throw new Error("Video Quality မမှန်ပါ။");

    const [width, height] = sizes[quality];
    const outputName = `${workId}.mp4`;
    const outputPath = path.join(OUTPUT_DIR, outputName);

    // Zoom ကို အနည်းငယ်သာထားပြီး ၅ စက္ကန့်အတွင်း
    // ဘယ်မှညာ၊ နောက် ၅ စက္ကန့်အတွင်း ညာမှဘယ်သို့
    // တကယ့် video frame များကို ရွေ့စေသည်။
    const motionFilter =
      `fps=30,` +
      `scale=${width}:${height}:force_original_aspect_ratio=increase,` +
      `crop=${width}:${height},` +
      `zoompan=` +
      `z='1.06':` +
      `x='(iw-iw/zoom)*(0.5-0.5*cos(PI*on/150))':` +
      `y='(ih-ih/zoom)/2':` +
      `d=1:s=${width}x${height}:fps=30,` +
      `format=yuv420p`;

    const args = ["-y", "-i", info.path];

    if (audioPath) args.push("-i", audioPath);

    args.push("-filter_complex");

    if (audioPath && info.hasAudio) {
      args.push(
        `[0:v]${motionFilter}[v];` +
        `[0:a]volume=0.22[original];` +
        `[1:a]volume=1.0[voice];` +
        `[original][voice]amix=inputs=2:duration=first:dropout_transition=2[a]`
      );
    } else if (audioPath) {
      args.push(`[0:v]${motionFilter}[v];[1:a]anull[a]`);
    } else {
      args.push(`[0:v]${motionFilter}[v]`);
    }

    args.push("-map", "[v]");

    if (audioPath) args.push("-map", "[a]");
    else if (info.hasAudio) args.push("-map", "0:a?");

    args.push(
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "23",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      "-c:a", "aac",
      "-b:a", "160k",
      "-threads", "2",
      outputPath
    );

    await execFileAsync(ffmpegPath, args, {
      maxBuffer: 30 * 1024 * 1024
    });

    res.json({
      success: true,
      filename: outputName,
      videoUrl: `/api/download/${outputName}`,
      quality,
      motion: "5-second alternating horizontal pan with subtle zoom"
    });
  } catch (error) {
    res.status(500).json({ success: false, message: publicError(error) });
  }
});

app.get("/api/download/:filename", (req, res) => {
  const filename = path.basename(req.params.filename);
  const filePath = path.join(OUTPUT_DIR, filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({
      success: false,
      message: "ဖိုင်မရှိတော့ပါ။"
    });
  }

  res.download(filePath);
});

app.use((error, _req, res, _next) => {
  const status = error?.code === "LIMIT_FILE_SIZE" ? 413 : 500;
  res.status(status).json({
    success: false,
    message: status === 413
      ? "ဖိုင်အရွယ်အစား 1GB ထက် ကျော်နေပါတယ်။"
      : publicError(error)
  });
});

app.listen(PORT, () => {
  console.log(`Burmese AI Recap backend listening on ${PORT}`);
});
