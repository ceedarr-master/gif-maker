const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const OUTPUT_DIR = path.join(__dirname, '..', 'output');
const MAX_SIZE_BYTES = 15 * 1024 * 1024; // 15MB

/**
 * Parse HH:MM:SS.ss or MM:SS.ss time string to seconds
 */
function parseTime(timeStr) {
  if (!timeStr) return 0;
  const parts = timeStr.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0];
}

/**
 * Get video duration in seconds using ffprobe
 */
function getVideoDuration(inputPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_streams',
      inputPath,
    ]);
    let out = '';
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.on('close', code => {
      if (code !== 0) return resolve(null);
      try {
        const info = JSON.parse(out);
        const videoStream = info.streams.find(s => s.codec_type === 'video');
        const duration = videoStream
          ? parseFloat(videoStream.duration || 0)
          : parseFloat((info.streams[0] || {}).duration || 0);
        resolve(duration || null);
      } catch (e) {
        resolve(null);
      }
    });
  });
}

/**
 * Run an ffmpeg command, parse progress from stderr.
 * onProgress(percent) called during encoding with 0-100 values.
 */
function runFFmpeg(args, totalDuration, onProgress) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';

    proc.stderr.on('data', chunk => {
      const text = chunk.toString();
      stderr += text;

      if (onProgress && totalDuration > 0) {
        const match = text.match(/time=(\d+:\d+:\d+\.\d+)/);
        if (match) {
          const elapsed = parseTime(match[1]);
          const percent = Math.min(99, Math.round((elapsed / totalDuration) * 100));
          onProgress(percent);
        }
      }
    });

    proc.on('close', code => {
      if (code === 0) resolve(stderr);
      else reject(new Error(`FFmpeg 오류 (코드 ${code}):\n${stderr.slice(-500)}`));
    });

    proc.on('error', err => reject(new Error(`FFmpeg 실행 실패: ${err.message}`)));
  });
}

/**
 * Two-pass high-quality GIF generation using palettegen + paletteuse.
 *
 * @param {string} inputPath  - Path to source video
 * @param {string} outputPath - Path for output GIF
 * @param {string} palettePath - Path for intermediate palette PNG
 * @param {object} params     - { startTime, duration, fps, width }
 * @param {function} onProgress - (percent 0-100) callback
 */
async function twoPassGif(inputPath, outputPath, palettePath, params, onProgress) {
  const { startTime, duration, fps, width } = params;

  const scaleFilter = width > 0
    ? `scale=${width}:-1:flags=lanczos`
    : 'scale=iw:-1:flags=lanczos';

  const baseArgs = [
    '-ss', String(startTime),
    '-t', String(duration),
    '-i', inputPath,
  ];

  // Pass 1: generate palette
  onProgress && onProgress(0);
  await runFFmpeg([
    ...baseArgs,
    '-vf', `fps=${fps},${scaleFilter},palettegen=max_colors=256:stats_mode=diff`,
    '-y', palettePath,
  ], duration, null);
  onProgress && onProgress(20);

  // Pass 2: encode GIF using palette
  await runFFmpeg([
    ...baseArgs,
    '-i', palettePath,
    '-lavfi', `fps=${fps},${scaleFilter} [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
    '-y', outputPath,
  ], duration, (pct) => {
    // Map 0-100% of pass 2 to overall 20-100%
    onProgress && onProgress(20 + Math.round(pct * 0.80));
  });
}

/**
 * Main conversion function.
 *
 * @param {string}   jobId      - Unique job identifier
 * @param {string}   inputPath  - Path to uploaded video
 * @param {object}   options    - { startTime, endTime, fps, width }
 * @param {function} emit       - (eventType, data) SSE callback
 */
async function convert(jobId, inputPath, options, emit) {
  const outputPath = path.join(OUTPUT_DIR, `${jobId}.gif`);
  const palettePath = path.join(OUTPUT_DIR, `${jobId}_palette.png`);

  emit('progress', { stage: 'init', percent: 0, message: '동영상 정보를 읽는 중...' });

  // Determine video duration
  const videoDuration = await getVideoDuration(inputPath);
  const startTime = Math.max(0, options.startTime || 0);
  let endTime = options.endTime;
  if (!endTime || endTime <= startTime) {
    endTime = videoDuration || startTime + 30;
  }
  if (videoDuration && endTime > videoDuration) {
    endTime = videoDuration;
  }
  let duration = Math.max(0.5, endTime - startTime);

  let fps = options.fps || 15;
  let width = options.width || 480;

  // Reduction ladder: attempts to bring file under 15MB
  const MAX_ATTEMPTS = 7;
  const reductionSteps = [
    null, // attempt 1: user settings
    (p) => { p.fps = Math.max(6, Math.floor(p.fps * 0.75)); },
    (p) => { p.width = Math.floor(p.width * 0.80); },
    (p) => { p.fps = Math.max(6, Math.floor(p.fps * 0.75)); },
    (p) => { p.width = Math.floor(p.width * 0.65); },
    (p) => { p.duration = Math.floor(p.duration * 0.80); },
  ];

  let lastError = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0 && reductionSteps[attempt]) {
      const params = { fps, width, duration };
      reductionSteps[attempt](params);
      fps = params.fps;
      width = params.width;
      duration = params.duration;

      emit('resize', {
        attempt,
        message: `파일 크기 초과 — FPS ${fps}, 너비 ${width}px, ${duration.toFixed(1)}초로 재시도 중...`,
      });
    }

    emit('progress', {
      stage: attempt === 0 ? 'palette' : 'retry-palette',
      percent: attempt === 0 ? 5 : 5,
      message: attempt === 0
        ? '색상 팔레트 생성 중...'
        : `재시도 ${attempt}: 색상 팔레트 생성 중...`,
    });

    try {
      await twoPassGif(
        inputPath,
        outputPath,
        palettePath,
        { startTime, duration, fps, width },
        (pct) => {
          emit('progress', {
            stage: pct < 20 ? 'palette' : 'encode',
            percent: pct,
            message: pct < 20
              ? '색상 팔레트 생성 중...'
              : `GIF 인코딩 중... ${pct}%`,
          });
        }
      );
    } catch (err) {
      lastError = err;
      // Try cleanup and continue to next attempt if possible
      try { fs.unlinkSync(palettePath); } catch (e) {}
      try { fs.unlinkSync(outputPath); } catch (e) {}
      if (attempt >= MAX_ATTEMPTS - 1) break;
      continue;
    }

    // Clean up palette
    try { fs.unlinkSync(palettePath); } catch (e) {}

    // Check output file size
    let sizeBytes;
    try {
      sizeBytes = fs.statSync(outputPath).size;
    } catch (e) {
      lastError = new Error('GIF 파일 생성에 실패했습니다.');
      break;
    }

    if (sizeBytes <= MAX_SIZE_BYTES) {
      // Success!
      const sizeLabel = formatSize(sizeBytes);
      emit('progress', { stage: 'done', percent: 100, message: '완료!' });
      emit('complete', {
        outputPath,
        sizeBytes,
        sizeLabel,
        width,
        fps,
        duration: parseFloat(duration.toFixed(2)),
      });
      return;
    }

    // File too large — try next reduction step
    if (attempt >= reductionSteps.length - 1) {
      // No more reduction steps
      emit('error', {
        message: `${formatSize(sizeBytes)} — 15MB 이하로 줄일 수 없습니다. 더 짧은 구간이나 작은 해상도를 선택해주세요.`,
      });
      return;
    }

    emit('resize', {
      attempt: attempt + 1,
      message: `출력 크기 ${formatSize(sizeBytes)} — 설정을 낮춰 재시도합니다...`,
    });

    try { fs.unlinkSync(outputPath); } catch (e) {}
  }

  // All attempts failed
  emit('error', {
    message: lastError
      ? lastError.message
      : '변환에 실패했습니다. 다른 동영상을 시도해주세요.',
  });
}

function formatSize(bytes) {
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / 1024).toFixed(0) + ' KB';
}

module.exports = { convert };
