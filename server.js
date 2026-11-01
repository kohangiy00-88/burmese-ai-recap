const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");

// ========================================
// Burmese AI Recap Backend
// ========================================

const app = express();

const PORT = process.env.PORT || 10000;

// Maximum upload size: 1 GB
const MAX_SIZE = 1024 * 1024 * 1024;

// Upload folders
const UPLOAD_DIR = path.join(__dirname, "uploads");
const AUDIO_DIR = path.join(UPLOAD_DIR, "audio");

// Allowed video formats
const ALLOWED_TYPES = [
  "video/mp4",
  "video/quicktime",
  "video/x-matroska",
  "video/webm",
  "video/x-msvideo"
];

// ========================================
// Create folders
// ========================================

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

if (!fs.existsSync(AUDIO_DIR)) {
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
}

// ========================================
// FFmpeg setup
// ========================================

if (ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath);
} else {
  console.error("FFmpeg binary was not found.");
}

// ========================================
// Middleware
// ========================================

app.use(cors());

app.use(express.json({ limit: "2mb" }));

app.use(express.urlencoded({ extended: true }));

// ========================================
// Helper functions
// ========================================

function isSafeFilename(filename) {
  if (typeof filename !== "string") {
    return false;
  }

  if (!filename.trim()) {
    return false;
  }

  if (
    filename.includes("..") ||
    filename.includes("/") ||
    filename.includes("\\")
  ) {
    return false;
  }

  return true;
}

function getVideoPath(filename) {
  return path.join(UPLOAD_DIR, filename);
}

// ========================================
// Home route
// ========================================

app.get("/", (req, res) => {
  res.json({
    success: true,
    name: "Burmese AI Recap Backend",
    status: "OK",
    message: "Backend is running"
  });
});

// ========================================
// Health check
// ========================================

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    status: "OK",
    message: "Backend is running",
    timestamp: new Date().toISOString()
  });
});

// ========================================
// Multer storage
// ========================================

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, UPLOAD_DIR);
  },

  filename: function (req, file, cb) {
    const extension = path.extname(file.originalname).toLowerCase();

    const uniqueName = crypto.randomUUID() + extension;

    cb(null, uniqueName);
  }
});

// ========================================
// Multer upload configuration
// ========================================

const upload = multer({
  storage: storage,

  limits: {
    fileSize: MAX_SIZE,
    files: 1
  },

  fileFilter: function (req, file, cb) {
    if (ALLOWED_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(
        new Error(
          "Unsupported video format. Please upload MP4, MOV, MKV, WEBM, or AVI."
        )
      );
    }
  }
});

// ========================================
// Upload video API
// POST /api/upload
// ========================================

app.post(
  "/api/upload",
  upload.single("video"),
  (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: "Video file is required"
        });
      }

      const file = req.file;

      const fileId = crypto.randomUUID();

      res.status(200).json({
        success: true,

        message: "Video uploaded successfully",

        file: {
          id: fileId,
          name: file.originalname,
          filename: file.filename,
          path: file.path,
          size: file.size,
          mimetype: file.mimetype
        }
      });

    } catch (error) {
      console.error("Upload error:", error);

      res.status(500).json({
        success: false,
        message: "Upload failed"
      });
    }
  }
);

// ========================================
// Extract audio API
// POST /api/extract-audio
//
// Request body:
// {
//   "filename": "uploaded-video.mp4"
// }
//
// Output:
// MP3 audio file
// ========================================

app.post("/api/extract-audio", (req, res) => {
  const filename = req.body.filename;

  // Check filename
  if (!isSafeFilename(filename)) {
    return res.status(400).json({
      success: false,
      message: "A valid video filename is required"
    });
  }

  // Check uploaded video
  const videoPath = getVideoPath(filename);

  if (!fs.existsSync(videoPath)) {
    return res.status(404).json({
      success: false,
      message: "Uploaded video was not found"
    });
  }

  // Check FFmpeg
  if (!ffmpegPath) {
    return res.status(500).json({
      success: false,
      message: "FFmpeg is not available on this server"
    });
  }

  // Generate output audio filename
  const audioFilename =
    path.parse(filename).name +
    "-" +
    crypto.randomUUID() +
    ".mp3";

  const audioPath = path.join(AUDIO_DIR, audioFilename);

  console.log("Starting audio extraction:", filename);

  ffmpeg(videoPath)
    .noVideo()
    .audioCodec("libmp3lame")
    .audioBitrate("128k")
    .format("mp3")

    .on("start", (commandLine) => {
      console.log("FFmpeg started");
    })

    .on("end", () => {
      try {
        if (!fs.existsSync(audioPath)) {
          return res.status(500).json({
            success: false,
            message: "Audio file was not created"
          });
        }

        const audioStats = fs.statSync(audioPath);

        console.log("Audio extraction completed:", audioFilename);

        return res.status(200).json({
          success: true,

          message: "Audio extracted successfully",

          audio: {
            filename: audioFilename,
            size: audioStats.size,
            format: "mp3",
            path: audioPath
          }
        });

      } catch (error) {
        console.error("Audio result error:", error);

        if (!res.headersSent) {
          return res.status(500).json({
            success: false,
            message: "Could not read extracted audio"
          });
        }
      }
    })

    .on("error", (error) => {
      console.error("FFmpeg audio extraction error:", error);

      // Remove incomplete audio file
      if (fs.existsSync(audioPath)) {
        try {
          fs.unlinkSync(audioPath);
        } catch (cleanupError) {
          console.error("Audio cleanup error:", cleanupError);
        }
      }

      if (!res.headersSent) {
        return res.status(500).json({
          success: false,
          message: "Audio extraction failed",
          error: error.message
        });
      }
    })

    .save(audioPath);
});

// ========================================
// Get uploaded video information
// GET /api/video/:filename
// ========================================

app.get("/api/video/:filename", (req, res) => {
  const filename = req.params.filename;

  if (!isSafeFilename(filename)) {
    return res.status(400).json({
      success: false,
      message: "Invalid filename"
    });
  }

  const videoPath = getVideoPath(filename);

  if (!fs.existsSync(videoPath)) {
    return res.status(404).json({
      success: false,
      message: "Video file was not found"
    });
  }

  const stats = fs.statSync(videoPath);

  res.json({
    success: true,

    file: {
      filename: filename,
      size: stats.size,
      sizeMB: Number(
        (stats.size / (1024 * 1024)).toFixed(2)
      ),
      createdAt: stats.birthtime
    }
  });
});

// ========================================
// Global error handler
// ========================================

app.use((error, req, res, next) => {
  console.error("Server error:", error);

  if (error instanceof multer.MulterError) {
    if (error.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({
        success: false,
        message: "Video exceeds the 1GB upload limit"
      });
    }

    if (error.code === "LIMIT_FILE_COUNT") {
      return res.status(400).json({
        success: false,
        message: "Only one video can be uploaded at a time"
      });
    }

    return res.status(400).json({
      success: false,
      message: error.message
    });
  }

  return res.status(400).json({
    success: false,
    message: error.message || "Something went wrong"
  });
});

// ========================================
// Start server
// ========================================

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Burmese AI Recap Backend running on port ${PORT}`
  );
});
