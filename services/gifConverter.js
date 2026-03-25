const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const OUTPUT_DIR = path.join(__dirname, '..', 'output');
const MAX_SIZE_BYTES = 15 * 1024 * 1024; // 15MB

// FPS-only reduction ladder (high → low)
const FPS_LADDER = [30, 24, 20, 15, 12, 10, 8, 6];

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
 * Get video info (duration, width, height) using ffprobe
 */
function getVideoInfo(inputPath) {
  return new Promise((resolve) => {
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
        if (!videoStream) return resolve(null);
        resolve({
          duration: parseFloat(videoStream.duration || 0) || null,
          width: videoStream.width || 0,
          height: videoStream.height || 0,
        });
      } catch (e) {
        resolve(null);
      }
    });
  });
}

/**
 * Run an ffmpeg command, parse progress from stderr.
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
 * Build the eq + optional unsharp filter string for correction.
 */
function buildCorrectionFilters({ brightness = 0, contrast = 1, saturation = 1, sharpLuma = 0, sharpChroma = 0 }) {
  const eq = `eq=brightness=${brightness}:contrast=${contrast}:saturation=${saturation}`;
  const useUnsharp = sharpLuma !== 0 || sharpChroma !== 0;
  const unsharp = useUnsharp ? `,unsharp=5:5:${sharpLuma}:3:3:${sharpChroma}` : '';
  return eq + unsharp;
}

/**
 * Two-pass high-quality GIF generation using palettegen + paletteuse.
 *
 * @param {string} inputPath    - Path to source video
 * @param {string} outputPath   - Path for output GIF
 * @param {string} palettePath  - Path for intermediate palette PNG
 * @param {object} params       - { startTime, duration, fps, width, brightness, contrast, saturation, sharpLuma, sharpChroma }
 * @param {function} onProgress - (percent 0-100) callback
 */
async function twoPassGif(inputPath, outputPath, palettePath, params, onProgress) {
  const {
    startTime, duration, fps, width,
    brightness = 0, contrast = 1, saturation = 1, sharpLuma = 0, sharpChroma = 0,
  } = params;

  // -2 ensures even height (required by GIF format); 0 = preserve original
  const scaleFilter = width > 0
    ? `scale=${width}:-2:flags=lanczos`
    : 'scale=iw:ih:flags=lanczos';

  const corrFilters = buildCorrectionFilters({ brightness, contrast, saturation, sharpLuma, sharpChroma });

  const baseArgs = [
    '-ss', String(startTime),
    '-t', String(duration),
    '-i', inputPath,
  ];

  // Pass 1: generate palette
  onProgress && onProgress(0);
  await runFFmpeg([
    ...baseArgs,
    '-vf', `fps=${fps},${scaleFilter},${corrFilters},palettegen=max_colors=256:stats_mode=diff`,
    '-y', palettePath,
  ], duration, null);
  onProgress && onProgress(20);

  // Pass 2: encode GIF using palette
  await runFFmpeg([
    ...baseArgs,
    '-i', palettePath,
    '-lavfi', `fps=${fps},${scaleFilter},${corrFilters} [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
    '-y', outputPath,
  ], duration, (pct) => {
    onProgress && onProgress(20 + Math.round(pct * 0.80));
  });
}

/**
 * Main conversion function.
 *
 * @param {string}   jobId     - Unique job identifier
 * @param {string}   inputPath - Path to uploaded video
 * @param {object}   options   - { startTime, endTime, fps, width, brightness, contrast, saturation, sharpLuma, sharpChroma, skipFpsLadder }
 * @param {function} emit      - (eventType, data) SSE callback
 */
async function convert(jobId, inputPath, options, emit) {
  const outputPath = path.join(OUTPUT_DIR, `${jobId}.gif`);
  const palettePath = path.join(OUTPUT_DIR, `${jobId}_palette.png`);

  emit('progress', { stage: 'init', percent: 0, message: '동영상 정보를 읽는 중...' });

  const videoInfo = await getVideoInfo(inputPath);
  if (videoInfo) {
    emit('info', { width: videoInfo.width, height: videoInfo.height });
  }

  const videoDuration = videoInfo ? videoInfo.duration : null;
  const startTime = Math.max(0, options.startTime || 0);
  let endTime = options.endTime;
  if (!endTime || endTime <= startTime) {
    endTime = videoDuration || startTime + 30;
  }
  if (videoDuration && endTime > videoDuration) {
    endTime = videoDuration;
  }
  const duration = Math.max(0.5, endTime - startTime);

  const corrections = {
    brightness: options.brightness || 0,
    contrast: options.contrast != null ? options.contrast : 1,
    saturation: options.saturation != null ? options.saturation : 1,
    sharpLuma: options.sharpLuma || 0,
    sharpChroma: options.sharpChroma || 0,
  };

  // 0 = preserve original dimensions
  const width = options.width || 0;
  const userFps = options.fps || 15;

  // --- Resolution retry: single attempt, then error ---
  if (options.skipFpsLadder) {
    emit('progress', { stage: 'palette', percent: 5, message: '색상 팔레트 생성 중...' });
    try {
      await twoPassGif(inputPath, outputPath, palettePath, { startTime, duration, fps: userFps, width, ...corrections }, (pct) => {
        emit('progress', {
          stage: pct < 20 ? 'palette' : 'encode',
          percent: pct,
          message: pct < 20 ? '색상 팔레트 생성 중...' : `GIF 인코딩 중... ${pct}%`,
        });
      });
    } catch (err) {
      try { fs.unlinkSync(palettePath); } catch (e) {}
      try { fs.unlinkSync(outputPath); } catch (e) {}
      emit('error', { message: err.message });
      return;
    }
    try { fs.unlinkSync(palettePath); } catch (e) {}

    let sizeBytes;
    try { sizeBytes = fs.statSync(outputPath).size; } catch (e) {
      emit('error', { message: 'GIF 파일 생성에 실패했습니다.' });
      return;
    }

    if (sizeBytes <= MAX_SIZE_BYTES) {
      emit('progress', { stage: 'done', percent: 100, message: '완료!' });
      emit('complete', { outputPath, sizeBytes, sizeLabel: formatSize(sizeBytes), width, fps: userFps, duration: parseFloat(duration.toFixed(2)) });
    } else {
      try { fs.unlinkSync(outputPath); } catch (e) {}
      emit('error', { message: `${formatSize(sizeBytes)} — 해상도를 줄여도 15MB 이하로 줄일 수 없습니다.` });
    }
    return;
  }

  // --- FPS-only reduction ladder ---
  // Start at or below user-requested FPS
  const fpsLadder = FPS_LADDER.filter(f => f <= userFps);
  if (fpsLadder.length === 0) fpsLadder.push(userFps);

  let anySucceeded = false;
  let lastSizeBytes = 0;

  for (let i = 0; i < fpsLadder.length; i++) {
    const fps = fpsLadder[i];

    if (i > 0) {
      emit('resize', { attempt: i, fps, message: `파일 크기 초과 — FPS ${fps}로 재시도 중...` });
    }

    emit('progress', {
      stage: i === 0 ? 'palette' : 'retry-palette',
      percent: 5,
      message: i === 0 ? '색상 팔레트 생성 중...' : `재시도 ${i}: 색상 팔레트 생성 중...`,
    });

    try {
      await twoPassGif(
        inputPath, outputPath, palettePath,
        { startTime, duration, fps, width, ...corrections },
        (pct) => {
          emit('progress', {
            stage: pct < 20 ? 'palette' : 'encode',
            percent: pct,
            message: pct < 20 ? '색상 팔레트 생성 중...' : `GIF 인코딩 중... ${pct}%`,
          });
        }
      );
    } catch (err) {
      try { fs.unlinkSync(palettePath); } catch (e) {}
      try { fs.unlinkSync(outputPath); } catch (e) {}
      continue; // try next FPS
    }

    try { fs.unlinkSync(palettePath); } catch (e) {}

    let sizeBytes;
    try {
      sizeBytes = fs.statSync(outputPath).size;
    } catch (e) {
      emit('error', { message: 'GIF 파일 생성에 실패했습니다.' });
      return;
    }

    anySucceeded = true;
    lastSizeBytes = sizeBytes;

    if (sizeBytes <= MAX_SIZE_BYTES) {
      emit('progress', { stage: 'done', percent: 100, message: '완료!' });
      emit('complete', {
        outputPath, sizeBytes, sizeLabel: formatSize(sizeBytes),
        width, fps, duration: parseFloat(duration.toFixed(2)),
      });
      return;
    }

    // Too large — try next FPS
    try { fs.unlinkSync(outputPath); } catch (e) {}
  }

  if (!anySucceeded) {
    emit('error', { message: 'GIF 변환에 실패했습니다. 다른 동영상을 시도해주세요.' });
    return;
  }

  // All FPS steps exhausted — ask user to trim
  const finalFps = fpsLadder[fpsLadder.length - 1];
  emit('needs-trim', {
    sizeBytes: lastSizeBytes,
    sizeLabel: formatSize(lastSizeBytes),
    finalFps,
    message: `${formatSize(lastSizeBytes)} — 클립을 더 짧게 잘라주세요`,
  });
}

function formatSize(bytes) {
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / 1024).toFixed(0) + ' KB';
}

module.exports = { convert };
