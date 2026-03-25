const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { convert } = require('../services/gifConverter');

const router = express.Router();

const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
const OUTPUT_DIR = path.join(__dirname, '..', 'output');

// Multer setup: store uploaded videos in uploads/
const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.mp4';
    cb(null, uuidv4() + ext);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB max
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('video/')) {
      cb(null, true);
    } else {
      cb(new Error('동영상 파일만 업로드 가능합니다.'));
    }
  },
});

// In-memory job state map
const jobs = new Map();

function emitEvent(jobId, eventType, data) {
  const job = jobs.get(jobId);
  if (!job) return;

  const eventStr = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  job.events.push({ eventType, data });

  if (job.sseRes) {
    job.sseRes.write(eventStr);
    if (eventType === 'complete' || eventType === 'error') {
      job.sseRes.end();
    }
  }
}

// POST /api/convert — upload video, start conversion
router.post('/convert', upload.single('video'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: '동영상 파일을 업로드해주세요.' });
  }

  const jobId = uuidv4();
  const options = {
    startTime: parseFloat(req.body.startTime) || 0,
    endTime: req.body.endTime ? parseFloat(req.body.endTime) : null,
    fps: Math.min(30, Math.max(6, parseInt(req.body.fps) || 15)),
    width: parseInt(req.body.width) || 480,
  };

  jobs.set(jobId, {
    status: 'processing',
    inputPath: req.file.path,
    outputPath: null,
    events: [],
    sseRes: null,
  });

  // Fire-and-forget conversion
  convert(jobId, req.file.path, options, (eventType, data) => {
    emitEvent(jobId, eventType, data);

    if (eventType === 'complete') {
      const job = jobs.get(jobId);
      if (job) {
        job.status = 'complete';
        job.outputPath = data.outputPath;
      }
      // Auto-cleanup after 10 minutes
      setTimeout(() => cleanupJob(jobId), 10 * 60 * 1000);
    } else if (eventType === 'error') {
      const job = jobs.get(jobId);
      if (job) job.status = 'error';
      setTimeout(() => cleanupJob(jobId), 5 * 60 * 1000);
    }
  }).catch(err => {
    emitEvent(jobId, 'error', { message: err.message });
    const job = jobs.get(jobId);
    if (job) job.status = 'error';
    setTimeout(() => cleanupJob(jobId), 5 * 60 * 1000);
  });

  res.status(202).json({ jobId });
});

// GET /api/progress/:jobId — SSE stream
router.get('/progress/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);

  if (!job) {
    return res.status(404).json({ error: '작업을 찾을 수 없습니다.' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Flush any already-queued events (race condition safety)
  for (const { eventType, data } of job.events) {
    res.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
    if (eventType === 'complete' || eventType === 'error') {
      res.end();
      return;
    }
  }

  // If job already done before SSE connected
  if (job.status === 'complete' || job.status === 'error') {
    res.end();
    return;
  }

  job.sseRes = res;

  req.on('close', () => {
    if (job.sseRes === res) job.sseRes = null;
  });
});

// GET /api/download/:jobId — stream GIF file
router.get('/download/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);

  if (!job || job.status !== 'complete' || !job.outputPath) {
    return res.status(404).json({ error: 'GIF 파일을 찾을 수 없습니다.' });
  }

  const isPreview = req.query.preview === '1';
  const filename = `output_${jobId.slice(0, 8)}.gif`;

  res.setHeader('Content-Type', 'image/gif');
  if (!isPreview) {
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  }

  const stat = fs.statSync(job.outputPath);
  res.setHeader('Content-Length', stat.size);

  const stream = fs.createReadStream(job.outputPath);
  stream.pipe(res);
});

function cleanupJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;
  try { if (job.inputPath) fs.unlinkSync(job.inputPath); } catch (e) {}
  try { if (job.outputPath) fs.unlinkSync(job.outputPath); } catch (e) {}
  // Remove palette file if somehow left behind
  try {
    const palettePath = job.outputPath
      ? job.outputPath.replace('.gif', '_palette.png')
      : null;
    if (palettePath) fs.unlinkSync(palettePath);
  } catch (e) {}
  jobs.delete(jobId);
}

module.exports = router;
