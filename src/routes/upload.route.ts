import { Router } from 'express';
import type { Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import { requireAuth } from '../middleware/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const storage = multer.diskStorage({
  destination: path.join(__dirname, '../../uploads'),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  },
});

const ALLOWED_IMAGE = /\.(jpeg|jpg|png|webp|gif)$/i;
const ALLOWED_VIDEO = /\.(mp4|webm|mov|avi|mkv)$/i;
const ALLOWED_DOC   = /\.(pdf|doc|docx|txt)$/i;

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB max
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const isImage = ALLOWED_IMAGE.test(ext) || file.mimetype.startsWith('image/');
    const isVideo = ALLOWED_VIDEO.test(ext) || file.mimetype.startsWith('video/');
    const isDoc   = ALLOWED_DOC.test(ext)   || file.mimetype === 'application/pdf';
    if (isImage || isVideo || isDoc) cb(null, true);
    else cb(new Error('Unsupported file type'));
  },
});

const router = Router();

router.post('/', requireAuth, upload.single('file'), (req: Request, res: Response) => {
  if (!req.file) {
    res.status(400).json({ success: false, message: 'No file uploaded' });
    return;
  }
  // Use SERVER_URL from environment, fallback to localhost for development
  const serverUrl = process.env.SERVER_URL || 'http://localhost:5000';
  res.json({ success: true, url: `${serverUrl}/uploads/${req.file.filename}` });
});

export default router;
