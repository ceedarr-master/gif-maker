const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Create temp directories on startup
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const OUTPUT_DIR = path.join(__dirname, 'output');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));

// API routes
const convertRouter = require('./routes/convert');
app.use('/api', convertRouter);

// Cleanup temp files on shutdown
function cleanup() {
  try {
    const uploadFiles = fs.readdirSync(UPLOADS_DIR);
    uploadFiles.forEach(f => fs.unlinkSync(path.join(UPLOADS_DIR, f)));
    const outputFiles = fs.readdirSync(OUTPUT_DIR);
    outputFiles.forEach(f => fs.unlinkSync(path.join(OUTPUT_DIR, f)));
  } catch (e) {
    // ignore errors on cleanup
  }
}

process.on('SIGINT', () => {
  cleanup();
  process.exit(0);
});
process.on('SIGTERM', () => {
  cleanup();
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`GIF Maker running at http://localhost:${PORT}`);
});
