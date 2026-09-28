import multer from "multer";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..", "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
const configuredDataRoot = process.env.DATA_DIR;
const runtimeDataRoot = configuredDataRoot
  ? (path.isAbsolute(configuredDataRoot) ? configuredDataRoot : path.resolve(projectRoot, configuredDataRoot))
  : path.join(projectRoot, "data");

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024; // 15 MB per file
export const uploadsRoot = path.join(runtimeDataRoot, "uploads");
export const documentUploadsDir = path.join(uploadsRoot, "documents");
export const reportUploadsDir = path.join(uploadsRoot, "reports");
export const propertyUploadsDir = path.join(uploadsRoot, "properties");
export const backupsDir = path.join(runtimeDataRoot, "backups");

export const documentExtensions = new Set([
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp",
]);
export const reportExtensions = new Set([".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx"]);
// Property pictures are optional and image-only.
export const propertyImageExtensions = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);

export const extensionMime = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

export function ensureUploadDirs() {
  fs.mkdirSync(documentUploadsDir, { recursive: true });
  fs.mkdirSync(reportUploadsDir, { recursive: true });
  fs.mkdirSync(propertyUploadsDir, { recursive: true });
}

export function safeExtension(originalName) {
  const ext = path.extname(String(originalName || "")).toLowerCase();
  return /^\.[a-z0-9]{2,8}$/.test(ext) ? ext : "";
}

// Display name for downloads: strip directories and dangerous characters.
export function safeDisplayFilename(originalName, fallback = "file") {
  const base = path.basename(String(originalName || "")).replace(/[\\/:*?"<>|\x00-\x1f]+/g, "_").trim();
  return (base || fallback).slice(0, 160);
}

function mimeMatchesExtension(extension, mimeType) {
  const expected = extensionMime[extension];
  if (!expected) return false;
  const actual = String(mimeType || "").toLowerCase().split(";")[0].trim();
  return actual === expected || actual === "application/octet-stream";
}

function storageFor(directory) {
  return multer.diskStorage({
    destination(req, file, cb) {
      try {
        fs.mkdirSync(directory, { recursive: true });
        cb(null, directory);
      } catch (error) {
        cb(error);
      }
    },
    filename(req, file, cb) {
      // UUID storage name: no user-controlled path components ever hit disk.
      cb(null, `${crypto.randomUUID()}${safeExtension(file.originalname)}`);
    },
  });
}

function makeUploader(directory, allowedExtensions) {
  const upload = multer({
    storage: storageFor(directory),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 24 },
    fileFilter(req, file, cb) {
      const ext = safeExtension(file.originalname);
      if (!ext || !allowedExtensions.has(ext) || !mimeMatchesExtension(ext, file.mimetype)) {
        const error = new Error(`Unsupported file type. Allowed: ${[...allowedExtensions].join(", ")}`);
        error.status = 400;
        return cb(error);
      }
      if (!file.originalname || file.originalname.length > 255) {
        const error = new Error("The uploaded file is invalid or empty.");
        error.status = 400;
        return cb(error);
      }
      cb(null, true);
    },
  });
  return (req, res, cb) => {
    upload.single("file")(req, res, (error) => {
      if (error) {
        // Multer already removed partial files it created for size-limit errors.
        const friendly = error.code === "LIMIT_FILE_SIZE"
          ? `File is too large. Maximum size is ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB.`
          : error.message || "Upload failed.";
        const wrapped = new Error(friendly);
        wrapped.status = 400;
        return cb(wrapped);
      }
      cb(null);
    });
  };
}

export const uploadDocumentFile = makeUploader(documentUploadsDir, documentExtensions);
export const uploadReportFile = makeUploader(reportUploadsDir, reportExtensions);
export const uploadPropertyImageFile = makeUploader(propertyUploadsDir, propertyImageExtensions);

export function validateUploadedFile(file, allowedExtensions) {
  if (!file) {
    const error = new Error("Choose a file to upload.");
    error.status = 400;
    throw error;
  }
  const extension = safeExtension(file.originalname);
  if (!extension || !allowedExtensions.has(extension) || !mimeMatchesExtension(extension, file.mimetype)) {
    const error = new Error(`Unsupported file type. Allowed: ${[...allowedExtensions].join(", ")}`);
    error.status = 400;
    throw error;
  }
  if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_UPLOAD_BYTES) {
    const error = new Error(`File must be between 1 byte and ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB.`);
    error.status = 400;
    throw error;
  }
  if (!file.path || !fs.existsSync(file.path)) {
    const error = new Error("The uploaded file could not be stored.");
    error.status = 500;
    throw error;
  }
  return {
    extension,
    displayName: safeDisplayFilename(file.originalname, `upload${extension}`),
    storedName: file.filename,
    size: file.size,
    mimeType: extensionMime[extension],
  };
}

export function cleanupUploadedFile(file) {
  if (!file?.path) return;
  try {
    fs.unlinkSync(file.path);
  } catch (error) {
    if (error.code !== "ENOENT") console.error("Failed to clean rejected upload:", error.message);
  }
}

// Resolves a stored file only when it stays inside its own upload directory.
export function resolveStoredFile(directory, storedName) {
  if (!storedName || typeof storedName !== "string") return null;
  if (storedName !== path.basename(storedName)) return null;
  const fullPath = path.resolve(directory, storedName);
  const root = path.resolve(directory);
  if (fullPath !== root && !fullPath.startsWith(root + path.sep)) return null;
  return fs.existsSync(fullPath) ? fullPath : null;
}

export function removeStoredFile(directory, storedName) {
  try {
    const fullPath = resolveStoredFile(directory, storedName);
    if (fullPath) fs.unlinkSync(fullPath);
  } catch (error) {
    console.error("Failed to remove stored file:", error.message);
  }
}

/**
 * Whether a stored file is actually present on disk.
 *
 * A stored row and its file are two different things: a restore, a moved data
 * directory, or a cleanup can leave the row behind after the artefact is gone.
 * Callers that render a link to the file need to know which of the two they are
 * looking at, so availability is resolved at read time instead of assumed from
 * the row existing. Delegates to `resolveStoredFile` so the path-traversal rules
 * are enforced in exactly one place.
 */
export function storedFileExists(directory, storedName) {
  return resolveStoredFile(directory, storedName) !== null;
}
