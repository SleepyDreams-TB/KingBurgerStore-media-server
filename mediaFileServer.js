import express from "express";
import path from "path";
import multer from "multer";
import fs from "fs";
import { randomUUID } from "crypto";
import rateLimit from "express-rate-limit";

const app = express();

// ─── Config ────────────────────────────────────────────────────────────────────
const VALID_USERNAME = process.env.MEDIA_SERVER_USER;
const VALID_PASSWORD = process.env.MEDIA_SERVER_PASS;
const PORT = process.env.PORT || 3000;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = "SleepyDreams-TB";
const GITHUB_REPO = "KingBurgerStore-media-server";
const GITHUB_BRANCH = "main";
const ALLOWED_ORIGINS = ["https://kingburger.site", "https://media.kingburger.site"];

// ─── Rate Limiting ──────────────────────────────────────────────────────────────
const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,   // 1 minute
  max: 20,               // max 20 uploads per minute per IP
  message: { error: "Too many upload requests. Please wait a moment." }
});

// ─── Authentication Middleware ──────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Basic ")) {
    res.set("WWW-Authenticate", 'Basic realm="Media Server"');
    return res.status(401).json({ error: "Authentication required" });
  }

  const base64Credentials = authHeader.slice(6);
  const credentials = Buffer.from(base64Credentials, "base64").toString("utf8");
  const colonIndex = credentials.indexOf(":");
  const username = credentials.slice(0, colonIndex);
  const password = credentials.slice(colonIndex + 1);

  if (username === VALID_USERNAME && password === VALID_PASSWORD) {
    return next();
  }

  res.set("WWW-Authenticate", 'Basic realm="Media Server"');
  return res.status(401).json({ error: "Invalid credentials" });
}

// ─── CORS Helper ───────────────────────────────────────────────────────────────
function setCorsHeaders(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

// ─── CORS Preflight ─────────────────────────────────────────────────────────────
app.options("/upload", (req, res) => {
  setCorsHeaders(req, res);
  res.sendStatus(200);
});

// ─── Static Files (public — images are intentionally public) ───────────────────
app.use("/images", express.static(path.join(process.cwd(), "images")));

// ─── Admin / UI (requires auth) ────────────────────────────────────────────────
app.use(requireAuth);
app.use(express.static(process.cwd()));

// ─── Multer Configuration ───────────────────────────────────────────────────────
const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

const upload = multer({
  dest: "uploads/",
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Invalid file type. Only JPG, PNG, GIF, and WEBP are allowed."));
    }
  }
});

// ─── Filename Sanitiser ─────────────────────────────────────────────────────────
function sanitiseFilename(name) {
  return name
    .replace(/[/\\?%*:|"<>]/g, "-")  // replace shell-dangerous chars
    .replace(/\.\./g, "-")            // prevent path traversal
    .replace(/^\.+/, "")              // no leading dots
    .trim()
    .slice(0, 100);                   // max length
}

// ─── Upload Endpoint ────────────────────────────────────────────────────────────
app.post("/upload", uploadLimiter, upload.single("file"), async (req, res) => {
  setCorsHeaders(req, res);

  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded." });
  }

  try {
    const originalName = req.file.originalname || "upload";
    const extMatch = originalName.match(/\.(jpe?g|png|gif|webp)$/i);
    const ext = extMatch ? extMatch[0].toLowerCase() : ".jpg";
    const baseName = sanitiseFilename(originalName.replace(/\.[^.]+$/, "")) || randomUUID();
    const safeName = `${baseName}-${randomUUID().slice(0, 8)}${ext}`;
    const imagesPath = `images/${safeName}`;

    const fileData = await fs.promises.readFile(req.file.path);
    const base64File = fileData.toString("base64");

    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${imagesPath}`;

    const githubRes = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `token ${GITHUB_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        message: `Upload image ${safeName}`,
        content: base64File,
        branch: GITHUB_BRANCH
      })
    });

    const data = await githubRes.json();

    if (githubRes.ok) {
      return res.status(201).json({
        success: true,
        filename: safeName,
        url: data.content.download_url
      });
    } else {
      console.error("GitHub API error:", data);
      return res.status(502).json({ error: `GitHub upload failed: ${data.message}` });
    }
  } catch (err) {
    console.error("Upload error:", err);
    return res.status(500).json({ error: `Server error: ${err.message}` });
  } finally {
    if (req.file?.path) {
      fs.unlink(req.file.path, () => { });
    }
  }
});

// ─── Error Handling Middleware (must be last) ───────────────────────────────────
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: `Upload error: ${err.message}` });
  }
  if (err) {
    return res.status(400).json({ error: err.message });
  }
  next();
});

// ─── Start ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Media server running on port ${PORT}`);
});