const express = require("express");
const cors = require("cors");
const multer = require("multer");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 10000;

ffmpeg.setFfmpegPath(ffmpegPath);

const ROOT = __dirname;
const UPLOAD_DIR = path.join(ROOT, "uploads");
const AUDIO_DIR = path.join(UPLOAD_DIR, "audio");
const OUTPUT_DIR = path.join(ROOT, "outputs");

for (const dir of [UPLOAD_DIR, AUDIO_DIR, OUTPUT_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

app.use(cors());
app.use(express.json({ limit: "5mb" }));

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Burmese AI Video Backend"
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    status: "OK"
  });
});

function safeName(name) {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length < 200 &&
    path.basename(name) === name &&
    !name.includes("..")
  );
}

function makeStorage(destination, allowedTypes) {
  return multer.diskStorage({
    destination: (req, file, cb) => cb(null, destination),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, crypto.randomUUID() + ext);
    }
  });
}

const videoTypes = [
  "video/mp4",
  "video/quicktime",
  "video/x-matroska",
  "video/webm",
  "video/x-msvideo",
  "application/octet-stream"
];

const audioTypes = [
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/mp4",
  "audio/aac",
  "audio/ogg",
  "audio/webm",
  "audio/flac",
  "application/octet-stream"
];

const videoUpload = multer({
  storage: makeStorage(UPLOAD_DIR),
  limits: {
    fileSize: 1024 * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    if (!videoTypes.includes(file.mimetype)) {
      return cb(new Error("Video ဖိုင်အမျိုးအစားကိုသာ တင်ပါ။"));
    }
    cb(null, true);
  }
});

const audioUpload = multer({
  storage: makeStorage(AUDIO_DIR),
  limits: {
    fileSize: 200 * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    if (!audioTypes.includes(file.mimetype)) {
      return cb(new Error("Audio ဖိုင်အမျိုးအစားကိုသာ တင်ပါ။"));
    }
    cb(null, true);
  }
});

// VIDEO UPLOAD

app.post("/api/upload", videoUpload.single("video"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      success: false,
      message: "Video ဖိုင် မရရှိပါ။"
    });
  }

  res.json({
    success: true,
    message: "Video uploaded successfully",
    file: {
      id: crypto.randomUUID(),
      name: req.file.originalname,
      filename: req.file.filename,
      size: req.file.size,
      mimetype: req.file.mimetype
    }
  });
});

// AUDIO UPLOAD

app.post("/api/upload-audio", audioUpload.single("audio"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      success: false,
      message: "Audio ဖိုင် မရရှိပါ။"
    });
  }

  res.json({
    success: true,
    message: "Audio uploaded successfully",
    audio: {
      filename: req.file.filename,
      size: req.file.size,
      mimetype: req.file.mimetype
    }
  });
});

// AUTO RECAP
// AI Provider API မချိတ်ဆက်ရသေးသဖြင့် ယာယီရှင်းလင်းသော Error ပြန်ပေးသည်။

app.post("/api/recap", async (req, res) => {
  return res.status(501).json({
    success: false,
    message:
      "Auto Recap အတွက် AI Transcription နှင့် Summarization API ကို Backend တွင် ချိတ်ဆက်ရန် လိုအပ်ပါသည်။"
  });
});

// RENDER VIDEO + VOICEOVER

app.post("/api/render", async (req, res) => {
  try {
    const { filename, audioFilename, quality } = req.body;

    if (!safeName(filename) || !safeName(audioFilename)) {
      return res.status(400).json({
        success: false,
        message: "ဖိုင်အမည် မမှန်ကန်ပါ။"
      });
    }

    const inputVideo = path.join(UPLOAD_DIR, filename);
    const inputAudio = path.join(AUDIO_DIR, audioFilename);

    if (!fs.existsSync(inputVideo) || !fs.existsSync(inputAudio)) {
      return res.status(404).json({
        success: false,
        message: "Video သို့မဟုတ် Audio ဖိုင်ကို မတွေ့ပါ။"
      });
    }

    const outputFilename =
      "recap-" + crypto.randomUUID() + ".mp4";

    const outputPath = path.join(OUTPUT_DIR, outputFilename);

    const height = {
      "480": 480,
      "720": 720,
      "1080": 1080
    }[String(quality)] || 1080;

    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(inputVideo)
        .input(inputAudio)
        .outputOptions([
          "-map 0:v:0",
          "-map 1:a:0",
          "-c:v libx264",
          "-preset veryfast",
          "-crf 23",
          "-vf scale=-2:" + height,
          "-c:a aac",
          "-b:a 192k",
          "-pix_fmt yuv420p",
          "-movflags +faststart",
          "-shortest"
        ])
        .format("mp4")
        .on("end", resolve)
        .on("error", reject)
        .save(outputPath);
    });

    res.json({
      success: true,
      message: "Render completed",
      filename: outputFilename
    });

  } catch (error) {
    console.error("Render error:", error);

    res.status(500).json({
      success: false,
      message: "Video Render မအောင်မြင်ပါ။",
      error: error.message
    });
  }
});

// DOWNLOAD MP4

app.get("/api/download/:filename", (req, res) => {
  const filename = req.params.filename;

  if (!safeName(filename) || !filename.endsWith(".mp4")) {
    return res.status(400).json({
      success: false,
      message: "ဖိုင်အမည် မမှန်ကန်ပါ။"
    });
  }

  const filePath = path.join(OUTPUT_DIR, filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({
      success: false,
      message: "MP4 ဖိုင် မတွေ့ပါ။"
    });
  }

  res.download(filePath, filename);
});

// ERROR HANDLER

app.use((error, req, res, next) => {
  console.error(error);

  if (error instanceof multer.MulterError) {
    return res.status(400).json({
      success: false,
      message:
        error.code === "LIMIT_FILE_SIZE"
          ? "ဖိုင်အရွယ်အစား ကန့်သတ်ချက် ကျော်နေပါတယ်။"
          : error.message
    });
  }

  res.status(500).json({
    success: false,
    message: error.message || "Server Error"
  });
});

app.listen(PORT, () => {
  console.log("Backend running on port " + PORT);
});
