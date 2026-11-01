
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();

const PORT = process.env.PORT || 10000;

const MAX_SIZE = 1024 * 1024 * 1024;

const UPLOAD_DIR = path.join(__dirname, "uploads");

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

app.use(cors());

app.use(express.json());

app.get("/", (req, res) => {
  res.json({
    success: true,
    name: "Burmese AI Recap Backend",
    status: "OK"
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    status: "OK",
    message: "Backend is running"
  });
});

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, UPLOAD_DIR);
  },

  filename: function (req, file, cb) {
    const extension = path.extname(file.originalname);

    const uniqueName =
      crypto.randomUUID() + extension;

    cb(null, uniqueName);
  }
});

const upload = multer({
  storage: storage,

  limits: {
    fileSize: MAX_SIZE
  },

  fileFilter: function (req, file, cb) {
    const allowedTypes = [
      "video/mp4",
      "video/quicktime",
      "video/x-matroska",
      "video/webm",
      "video/x-msvideo"
    ];

    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(
        new Error(
          "Unsupported video format"
        )
      );
    }
  }
});

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

      res.json({
        success: true,

        message: "Video uploaded successfully",

        file: {
          id: crypto.randomUUID(),

          name: file.originalname,

          filename: file.filename,

          path: file.path,

          size: file.size,

          mimetype: file.mimetype
        }
      });

    } catch (error) {
      console.error(error);

      res.status(500).json({
        success: false,
        message: "Upload failed"
      });
    }
  }
);

app.use((error, req, res, next) => {
  console.error(error);

  if (error instanceof multer.MulterError) {
    if (error.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({
        success: false,
        message: "Video exceeds the 1GB upload limit"
      });
    }

    return res.status(400).json({
      success: false,
      message: error.message
    });
  }

  res.status(400).json({
    success: false,
    message:
      error.message || "Something went wrong"
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Burmese AI Recap Backend running on port ${PORT}`
  );
});
