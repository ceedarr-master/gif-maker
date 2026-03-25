/* ===== App State ===== */
const appState = {
  step: 'upload',
  file: null,
  videoObjectUrl: null,
  videoDuration: 0,
  videoNativeWidth: 0,
  videoNativeHeight: 0,
  trimStart: 0,
  trimEnd: 0,
  fps: 15,
  width: 0,              // 0 = original
  corrections: { brightness: 0, contrast: 1.0, saturation: 1.0, sharpLuma: 0, sharpChroma: 0 },
  sourceJobId: null,     // reused for retries, avoids re-upload
  currentJobId: null,
  retryCount: 0,
  needsTrimData: null,
  selectedResScale: null,
  eventSource: null,
};

/* ===== Element References ===== */
const dropZone      = document.getElementById('drop-zone');
const fileInput     = document.getElementById('file-input');
const videoPreview  = document.getElementById('video-preview');
const scrubberCanvas = document.getElementById('scrubber-canvas');
const scrubberStrip  = document.getElementById('scrubber-strip');
const scrubberRange  = document.getElementById('scrubber-range');
const handleStart   = document.getElementById('handle-start');
const handleEnd     = document.getElementById('handle-end');
const labelStart    = document.getElementById('label-start');
const labelEnd      = document.getElementById('label-end');
const labelDuration = document.getElementById('label-duration');
const needsTrimBanner = document.getElementById('needs-trim-banner');

const progressBar     = document.getElementById('progress-bar');
const progressMessage = document.getElementById('progress-message');
const resizeNotice    = document.getElementById('resize-notice');

const resultMeta  = document.getElementById('result-meta');
const gifPreview  = document.getElementById('gif-preview');
const downloadBtn = document.getElementById('download-btn');
const errorMsg    = document.getElementById('error-message');
const wizardSteps = document.getElementById('wizard-steps');

/* ===== Section Management ===== */
const SECTIONS = ['upload', 'trim', 'corrections', 'converting', 'needs-res', 'result', 'error'];

function showSection(name) {
  SECTIONS.forEach(s => {
    document.getElementById(`step-${s}`).hidden = (s !== name);
  });
  updateWizardDots(name);
}

function updateWizardDots(name) {
  const stepMap = { upload: 0, trim: 1, corrections: 2, converting: 3, 'needs-res': 3, result: 4, error: 4 };
  const activeStep = stepMap[name] ?? 0;

  if (activeStep === 0) {
    wizardSteps.hidden = true;
    return;
  }
  wizardSteps.hidden = false;

  document.querySelectorAll('.wizard-step').forEach(dot => {
    const s = parseInt(dot.dataset.step);
    dot.classList.toggle('done',   s < activeStep);
    dot.classList.toggle('active', s === activeStep);
    dot.classList.remove(...(s < activeStep ? ['active'] : []), ...(s === activeStep ? ['done'] : []));
    // cleaner version:
    dot.className = 'wizard-step' +
      (s < activeStep ? ' done' : '') +
      (s === activeStep ? ' active' : '');
  });
}

/* ===== Drop Zone ===== */
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
});
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  if (file) handleFileSelect(file);
});
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) handleFileSelect(fileInput.files[0]);
});

function handleFileSelect(file) {
  if (!file.type.startsWith('video/')) {
    alert('동영상 파일만 업로드할 수 있습니다.');
    return;
  }
  if (file.size > 500 * 1024 * 1024) {
    alert('파일 크기는 500MB 이하여야 합니다.');
    return;
  }

  appState.file = file;
  if (appState.videoObjectUrl) URL.revokeObjectURL(appState.videoObjectUrl);
  appState.videoObjectUrl = URL.createObjectURL(file);
  videoPreview.src = appState.videoObjectUrl;
}

videoPreview.addEventListener('loadedmetadata', async () => {
  const dur = videoPreview.duration;
  appState.videoDuration = isFinite(dur) ? dur : 0;
  appState.videoNativeWidth  = videoPreview.videoWidth;
  appState.videoNativeHeight = videoPreview.videoHeight;
  appState.trimStart = 0;
  appState.trimEnd   = appState.videoDuration;

  // Reset trim-related UI state
  appState.retryCount = 0;
  appState.sourceJobId = null;
  appState.needsTrimData = null;
  needsTrimBanner.hidden = true;

  updateHandlePositions();
  showSection('trim');

  // Draw filmstrip asynchronously (non-blocking)
  drawScrubberStrip(videoPreview, scrubberCanvas).catch(() => {});
});

/* ===== Scrubber Filmstrip ===== */
async function seekVideoTo(videoEl, time) {
  return new Promise(resolve => {
    const timeout = setTimeout(resolve, 500); // iOS fallback
    const handler = () => {
      clearTimeout(timeout);
      videoEl.removeEventListener('seeked', handler);
      resolve();
    };
    videoEl.addEventListener('seeked', handler);
    videoEl.currentTime = time;
  });
}

async function drawScrubberStrip(videoEl, canvasEl) {
  const W = scrubberStrip.offsetWidth;
  const H = scrubberStrip.offsetHeight;
  if (!W || !H) return;

  canvasEl.width  = W;
  canvasEl.height = H;

  const numFrames = Math.min(10, Math.max(3, Math.floor(W / 40)));
  const ctx = canvasEl.getContext('2d');
  const frameW = W / numFrames;
  const duration = videoEl.duration;
  if (!isFinite(duration) || duration <= 0) return;

  for (let i = 0; i < numFrames; i++) {
    const t = (i / numFrames) * duration + duration / (numFrames * 2);
    await seekVideoTo(videoEl, t);
    ctx.drawImage(videoEl, i * frameW, 0, frameW, H);
  }
  videoEl.currentTime = 0;
}

/* ===== Scrubber Handle Dragging ===== */
function updateHandlePositions() {
  const dur = appState.videoDuration;
  if (dur <= 0) return;

  const startPct = appState.trimStart / dur;
  const endPct   = appState.trimEnd   / dur;

  handleStart.style.left = `${startPct * 100}%`;
  handleEnd.style.left   = `${endPct * 100}%`;
  scrubberRange.style.left  = `${startPct * 100}%`;
  scrubberRange.style.width = `${(endPct - startPct) * 100}%`;

  labelStart.textContent    = appState.trimStart.toFixed(1) + '초';
  labelEnd.textContent      = appState.trimEnd.toFixed(1) + '초';
  const clipDur = appState.trimEnd - appState.trimStart;
  labelDuration.textContent = clipDur.toFixed(1) + '초 선택됨';
}

(function initScrubber() {
  let dragging = null;

  function getPercent(clientX) {
    const rect = scrubberStrip.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  }

  [handleStart, handleEnd].forEach(handle => {
    handle.addEventListener('pointerdown', e => {
      e.preventDefault();
      dragging = handle === handleStart ? 'start' : 'end';
      handle.setPointerCapture(e.pointerId);
    });
  });

  scrubberStrip.addEventListener('pointermove', e => {
    if (!dragging) return;
    const pct  = getPercent(e.clientX);
    const time = pct * appState.videoDuration;
    const MIN_CLIP = 0.3;

    if (dragging === 'start') {
      appState.trimStart = Math.max(0, Math.min(time, appState.trimEnd - MIN_CLIP));
    } else {
      appState.trimEnd = Math.min(appState.videoDuration, Math.max(time, appState.trimStart + MIN_CLIP));
    }
    updateHandlePositions();
  });

  scrubberStrip.addEventListener('pointerup',     () => { dragging = null; });
  scrubberStrip.addEventListener('pointercancel', () => { dragging = null; });
})();

/* ===== FPS Pill Buttons ===== */
document.querySelectorAll('.fps-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.fps-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    appState.fps = parseInt(btn.dataset.fps);
  });
});

/* ===== Trim Step Actions ===== */
document.getElementById('to-corrections-btn').addEventListener('click', () => {
  showSection('corrections');
});

document.getElementById('skip-corrections-btn').addEventListener('click', () => {
  startConvert();
});

/* ===== Correction Sliders ===== */
['brightness', 'contrast', 'saturation'].forEach(key => {
  const slider = document.getElementById(key);
  const badge  = document.getElementById(`${key}-val`);
  slider.addEventListener('input', () => {
    const v = parseFloat(slider.value);
    appState.corrections[key] = v;
    badge.textContent = v.toFixed(key === 'brightness' ? 2 : 1);
  });
});

const sharpSlider = document.getElementById('sharpness');
sharpSlider.addEventListener('input', () => {
  const v = parseFloat(sharpSlider.value);
  appState.corrections.sharpLuma   = parseFloat((v * 0.75).toFixed(2));
  appState.corrections.sharpChroma = parseFloat((v * 0.30).toFixed(2));
  document.getElementById('sharpness-val').textContent = v.toFixed(1);
});

/* ===== Corrections Step Actions ===== */
document.getElementById('back-to-trim-btn').addEventListener('click', () => {
  showSection('trim');
});

document.getElementById('start-convert-btn').addEventListener('click', () => {
  startConvert();
});

/* ===== Convert ===== */
async function startConvert() {
  showSection('converting');
  progressBar.style.width = '2%';
  progressMessage.textContent = '업로드 중...';
  resizeNotice.hidden = true;

  const { trimStart, trimEnd, fps, width, corrections, file, sourceJobId } = appState;

  let jobId;
  try {
    if (sourceJobId) {
      // Retry: send JSON, no re-upload
      const body = {
        sourceJobId,
        startTime:  trimStart,
        endTime:    trimEnd,
        fps,
        width,
        brightness:  corrections.brightness,
        contrast:    corrections.contrast,
        saturation:  corrections.saturation,
        sharpLuma:   corrections.sharpLuma,
        sharpChroma: corrections.sharpChroma,
        skipFpsLadder: width > 0,
      };
      const res = await fetch('/api/convert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || '변환 요청 실패');
      }
      const data = await res.json();
      jobId = data.jobId;
    } else {
      // First upload: multipart
      const fd = new FormData();
      fd.append('video', file);
      fd.append('startTime',  trimStart);
      fd.append('endTime',    trimEnd);
      fd.append('fps',        fps);
      fd.append('width',      width);
      fd.append('brightness',  corrections.brightness);
      fd.append('contrast',    corrections.contrast);
      fd.append('saturation',  corrections.saturation);
      fd.append('sharpLuma',   corrections.sharpLuma);
      fd.append('sharpChroma', corrections.sharpChroma);

      const res = await fetch('/api/convert', { method: 'POST', body: fd });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || '업로드 실패');
      }
      const data = await res.json();
      jobId = data.jobId;
      appState.sourceJobId = jobId; // store for future retries
    }
  } catch (err) {
    showError(err.message);
    return;
  }

  appState.currentJobId = jobId;
  connectSSE(jobId);
}

/* ===== SSE ===== */
function connectSSE(jobId) {
  if (appState.eventSource) {
    appState.eventSource.close();
    appState.eventSource = null;
  }

  const es = new EventSource(`/api/progress/${jobId}`);
  appState.eventSource = es;

  es.addEventListener('progress', e => {
    const data = JSON.parse(e.data);
    progressBar.style.width = `${Math.max(2, data.percent)}%`;
    progressMessage.textContent = data.message || '';
  });

  es.addEventListener('resize', e => {
    const data = JSON.parse(e.data);
    resizeNotice.hidden = false;
    resizeNotice.textContent = `FPS ${data.fps}로 재시도 중...`;
  });

  es.addEventListener('complete', e => {
    const data = JSON.parse(e.data);
    es.close();
    appState.eventSource = null;
    handleComplete(jobId, data);
  });

  es.addEventListener('needs-trim', e => {
    const data = JSON.parse(e.data);
    es.close();
    appState.eventSource = null;
    appState.needsTrimData = data;
    appState.retryCount++;

    if (appState.retryCount >= 2) {
      // Show resolution fallback
      document.getElementById('needs-res-banner').textContent =
        `다시 시도해도 ${data.sizeLabel} — 해상도를 줄여야 합니다`;
      showSection('needs-res');
    } else {
      // Show trim request with warning banner
      needsTrimBanner.textContent = data.message;
      needsTrimBanner.hidden = false;
      // Use lowest FPS from last attempt for next retry
      appState.fps = data.finalFps;
      // Sync FPS buttons
      document.querySelectorAll('.fps-btn').forEach(b => {
        b.classList.toggle('active', parseInt(b.dataset.fps) === data.finalFps);
      });
      showSection('trim');
    }
  });

  es.addEventListener('error', e => {
    if (e.data) {
      const data = JSON.parse(e.data);
      es.close();
      appState.eventSource = null;
      showError(data.message);
    } else {
      es.close();
      appState.eventSource = null;
      showError('서버 연결이 끊어졌습니다. 다시 시도해주세요.');
    }
  });
}

/* ===== Cancel ===== */
document.getElementById('cancel-btn').addEventListener('click', () => {
  if (appState.eventSource) {
    appState.eventSource.close();
    appState.eventSource = null;
  }
  showSection('trim');
});

/* ===== Resolution Selection ===== */
document.querySelectorAll('.resolution-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.resolution-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    appState.selectedResScale = parseFloat(btn.dataset.scale);
    document.getElementById('confirm-res-btn').disabled = false;
  });
});

document.getElementById('confirm-res-btn').addEventListener('click', () => {
  const origW = appState.videoNativeWidth;
  let w = Math.floor(origW * appState.selectedResScale);
  if (w % 2 !== 0) w -= 1; // ensure even
  appState.width = w;
  if (appState.needsTrimData) {
    appState.fps = appState.needsTrimData.finalFps;
  }
  startConvert();
});

document.getElementById('back-to-trim-from-res-btn').addEventListener('click', () => {
  showSection('trim');
});

/* ===== Complete ===== */
function handleComplete(jobId, data) {
  resultMeta.innerHTML = `
    <span class="meta-chip size">${data.sizeLabel}</span>
    <span class="meta-chip">${data.fps} FPS</span>
    <span class="meta-chip">${data.width > 0 ? data.width + 'px' : '원본'} 가로</span>
    <span class="meta-chip">${data.duration}초</span>
  `;
  gifPreview.src = `/api/download/${jobId}?preview=1`;
  downloadBtn.href = `/api/download/${jobId}`;
  downloadBtn.download = `gif_${jobId.slice(0, 8)}.gif`;
  showSection('result');
}

/* ===== Error ===== */
function showError(msg) {
  errorMsg.textContent = msg;
  showSection('error');
}

/* ===== Reset ===== */
[document.getElementById('reset-btn'), document.getElementById('error-reset-btn')].forEach(btn => {
  btn.addEventListener('click', resetApp);
});

function resetApp() {
  if (appState.eventSource) {
    appState.eventSource.close();
    appState.eventSource = null;
  }

  if (appState.videoObjectUrl) {
    URL.revokeObjectURL(appState.videoObjectUrl);
    appState.videoObjectUrl = null;
  }

  Object.assign(appState, {
    step: 'upload',
    file: null,
    videoDuration: 0,
    videoNativeWidth: 0,
    videoNativeHeight: 0,
    trimStart: 0,
    trimEnd: 0,
    fps: 15,
    width: 0,
    corrections: { brightness: 0, contrast: 1.0, saturation: 1.0, sharpLuma: 0, sharpChroma: 0 },
    sourceJobId: null,
    currentJobId: null,
    retryCount: 0,
    needsTrimData: null,
    selectedResScale: null,
  });

  fileInput.value = '';
  videoPreview.src = '';
  gifPreview.src = '';
  downloadBtn.href = '#';
  needsTrimBanner.hidden = true;

  // Reset FPS buttons
  document.querySelectorAll('.fps-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.fps === '15');
  });

  // Reset correction sliders
  document.getElementById('brightness').value = 0;
  document.getElementById('brightness-val').textContent = '0';
  document.getElementById('contrast').value = 1;
  document.getElementById('contrast-val').textContent = '1.0';
  document.getElementById('saturation').value = 1;
  document.getElementById('saturation-val').textContent = '1.0';
  document.getElementById('sharpness').value = 0;
  document.getElementById('sharpness-val').textContent = '0.0';

  // Reset resolution buttons
  document.querySelectorAll('.resolution-btn').forEach(b => b.classList.remove('selected'));
  document.getElementById('confirm-res-btn').disabled = true;

  // Clear scrubber canvas
  const ctx = scrubberCanvas.getContext('2d');
  ctx.clearRect(0, 0, scrubberCanvas.width, scrubberCanvas.height);

  showSection('upload');
}
