const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { convert } = require('../services/gifConverter');

const router = express.Router();

const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
const OUTPUT_DIR = path.join(__dirname, '..', 'output');

// Multer setup
const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.mp4';
    cb(null, uuidv4() + ext);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('video/')) cb(null, true);
    else cb(new Error('동영상 파일만 업로드 가능합니다.'));
  },
});

// In-memory job state
const jobs = new Map();

// Helper to safely parse float with a default
function pfd(val, def) {
  const n = parseFloat(val);
  return isNaN(n) ? def : n;
}

function emitEvent(jobId, eventType, data) {
  const job = jobs.get(jobId);
  if (!job) return;

  // Internal-only event: store video dimensions in job
  if (eventType === 'info') {
    job.videoWidth = data.width;
    job.videoHeight = data.height;
    return;
  }

  const eventStr = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  job.events.push({ eventType, data });

  if (job.sseRes) {
    job.sseRes.write(eventStr);
    if (eventType === 'complete' || eventType === 'error' || eventType === 'needs-trim') {
      job.sseRes.end();
    }
  }
}

function buildOptions(body) {
  return {
    startTime: pfd(body.startTime, 0),
    endTime: body.endTime != null ? pfd(body.endTime, null) : null,
    fps: Math.min(30, Math.max(6, parseInt(body.fps) || 15)),
    width: parseInt(body.width) || 0,
    brightness: pfd(body.brightness, 0),
    contrast: pfd(body.contrast, 1.0),
    saturation: pfd(body.saturation, 1.0),
    sharpLuma: pfd(body.sharpLuma, 0),
    sharpChroma: pfd(body.sharpChroma, 0),
    skipFpsLadder: body.skipFpsLadder === true || body.skipFpsLadder === 'true',
  };
}

function startConversionJob(jobId, inputPath, options, sharedInput) {
  jobs.set(jobId, {
    status: 'processing',
    inputPath,
    outputPath: null,
    events: [],
    sseRes: null,
    sharedInput: !!sharedInput,
    videoWidth: 0,
    videoHeight: 0,
  });

  convert(jobId, inputPath, options, (eventType, data) => {
    emitEvent(jobId, eventType, data);

    if (eventType === 'complete') {
      const job = jobs.get(jobId);
      if (job) { job.status = 'complete'; job.outputPath = data.outputPath; }
      setTimeout(() => cleanupJob(jobId), 10 * 60 * 1000);
    } else if (eventType === 'error') {
      const job = jobs.get(jobId);
      if (job) job.status = 'error';
      setTimeout(() => cleanupJob(jobId), 5 * 60 * 1000);
    } else if (eventType === 'needs-trim') {
      const job = jobs.get(jobId);
      if (job) job.status = 'needs-trim';
      // Keep input file alive for retry — no cleanup timer
    }
  }).catch(err => {
    emitEvent(jobId, 'error', { message: err.message });
    const job = jobs.get(jobId);
    if (job) job.status = 'error';
    setTimeout(() => cleanupJob(jobId), 5 * 60 * 1000);
  });
}

// POST /api/convert — handles both new uploads (multipart) and retries (JSON + sourceJobId)
router.post('/convert',
  express.json({ limit: '10kb' }),
  (req, res, next) => {
    // If JSON body with sourceJobId: retry path, skip multer
    if (req.body && req.body.sourceJobId) {
      return handleRetryConvert(req, res);
    }
    // Otherwise: new upload via multipart
    upload.single('video')(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message });
      next();
    });
  },
  handleNewConvert
);

async function handleNewConvert(req, res) {
  if (!req.file) {
    return res.status(400).json({ error: '동영상 파일을 업로드해주세요.' });
  }

  const jobId = uuidv4();
  const options = buildOptions(req.body || {});
  startConversionJob(jobId, req.file.path, options, false);
  res.status(202).json({ jobId });
}

async function handleRetryConvert(req, res) {
  const { sourceJobId } = req.body;
  const sourceJob = jobs.get(sourceJobId);

  if (!sourceJob || !sourceJob.inputPath) {
    return res.status(404).json({ error: '원본 작업을 찾을 수 없습니다.' });
  }
  if (!fs.existsSync(sourceJob.inputPath)) {
    return res.status(404).json({ error: '원본 파일이 만료되었습니다. 다시 업로드해주세요.' });
  }

  const jobId = uuidv4();
  const options = buildOptions(req.body);
  // Use the source job's input file (sharedInput=true → don't delete on cleanup)
  startConversionJob(jobId, sourceJob.inputPath, options, true);
  res.status(202).json({ jobId });
}

// GET /api/progress/:jobId — SSE stream
router.get('/progress/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);

  if (!job) return res.status(404).json({ error: '작업을 찾을 수 없습니다.' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Flush already-queued events
  for (const { eventType, data } of job.events) {
    res.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
    if (eventType === 'complete' || eventType === 'error' || eventType === 'needs-trim') {
      res.end();
      return;
    }
  }

  if (job.status === 'complete' || job.status === 'error' || job.status === 'needs-trim') {
    res.end();
    return;
  }

  job.sseRes = res;
  req.on('close', () => { if (job.sseRes === res) job.sseRes = null; });
});

// GET /api/video-info/:jobId — original video dimensions for resolution calculation
router.get('/video-info/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'not found' });
  res.json({ width: job.videoWidth || 0, height: job.videoHeight || 0 });
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

  fs.createReadStream(job.outputPath).pipe(res);
});

function cleanupJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;
  // Only delete input file if it was uploaded specifically for this job (not shared)
  if (!job.sharedInput) {
    try { if (job.inputPath) fs.unlinkSync(job.inputPath); } catch (e) {}
  }
  try { if (job.outputPath) fs.unlinkSync(job.outputPath); } catch (e) {}
  try { fs.unlinkSync(path.join(OUTPUT_DIR, `${jobId}_palette.png`)); } catch (e) {}
  jobs.delete(jobId);
}

module.exports = router;
