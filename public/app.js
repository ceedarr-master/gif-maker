/* ===== Element References ===== */
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const videoPreviewWrap = document.getElementById('video-preview-wrap');
const videoPreview = document.getElementById('video-preview');
const videoInfo = document.getElementById('video-info');
const optionsPanel = document.getElementById('options-panel');
const startTimeInput = document.getElementById('start-time');
const endTimeInput = document.getElementById('end-time');
const fpsSlider = document.getElementById('fps');
const fpsValue = document.getElementById('fps-value');
const widthSelect = document.getElementById('width');
const convertBtn = document.getElementById('convert-btn');

const uploadSection = document.getElementById('upload-section');
const progressSection = document.getElementById('progress-section');
const progressBar = document.getElementById('progress-bar');
const progressMessage = document.getElementById('progress-message');
const resizeNotice = document.getElementById('resize-notice');

const resultSection = document.getElementById('result-section');
const resultMeta = document.getElementById('result-meta');
const gifPreview = document.getElementById('gif-preview');
const downloadBtn = document.getElementById('download-btn');
const resetBtn = document.getElementById('reset-btn');

const errorSection = document.getElementById('error-section');
const errorMessage = document.getElementById('error-message');
const errorResetBtn = document.getElementById('error-reset-btn');

let selectedFile = null;
let currentEventSource = null;

/* ===== FPS Slider Live Update ===== */
fpsSlider.addEventListener('input', () => {
  fpsValue.textContent = fpsSlider.value;
});

/* ===== Drop Zone: Click ===== */
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    fileInput.click();
  }
});

/* ===== Drop Zone: Drag & Drop ===== */
dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('dragover');
});
dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('dragover');
});
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  if (file) handleFileSelect(file);
});

/* ===== File Input Change ===== */
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) handleFileSelect(fileInput.files[0]);
});

/* ===== Handle File Selection ===== */
function handleFileSelect(file) {
  if (!file.type.startsWith('video/')) {
    alert('동영상 파일만 업로드할 수 있습니다.');
    return;
  }
  if (file.size > 500 * 1024 * 1024) {
    alert('파일 크기는 500MB 이하여야 합니다.');
    return;
  }

  selectedFile = file;

  // Show video preview
  const url = URL.createObjectURL(file);
  videoPreview.src = url;
  videoPreviewWrap.hidden = false;
  optionsPanel.hidden = false;

  videoPreview.onloadedmetadata = () => {
    const dur = videoPreview.duration;
    const durStr = isFinite(dur) ? `${dur.toFixed(1)}초` : '알 수 없음';
    const sizeStr = formatBytes(file.size);
    videoInfo.textContent = `파일: ${file.name} · 크기: ${sizeStr} · 길이: ${durStr}`;

    // Auto-fill end time
    if (isFinite(dur)) {
      endTimeInput.value = dur.toFixed(1);
      startTimeInput.max = dur;
      endTimeInput.max = dur;
    }
  };
}

/* ===== Convert Button ===== */
convertBtn.addEventListener('click', async () => {
  if (!selectedFile) {
    alert('동영상 파일을 선택해주세요.');
    return;
  }

  const startTime = parseFloat(startTimeInput.value) || 0;
  const endTime = parseFloat(endTimeInput.value) || null;

  if (endTime !== null && endTime <= startTime) {
    alert('종료 시간은 시작 시간보다 커야 합니다.');
    return;
  }

  convertBtn.disabled = true;
  showSection('progress');
  setProgress(0, '업로드 중...');
  resizeNotice.hidden = true;

  const formData = new FormData();
  formData.append('video', selectedFile);
  formData.append('startTime', startTime);
  if (endTime !== null) formData.append('endTime', endTime);
  formData.append('fps', fpsSlider.value);
  formData.append('width', widthSelect.value);

  let jobId;
  try {
    const res = await fetch('/api/convert', { method: 'POST', body: formData });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || '업로드 실패');
    }
    const data = await res.json();
    jobId = data.jobId;
  } catch (err) {
    showError(err.message);
    return;
  }

  // Connect SSE
  connectSSE(jobId);
});

/* ===== SSE Progress Stream ===== */
function connectSSE(jobId) {
  if (currentEventSource) {
    currentEventSource.close();
    currentEventSource = null;
  }

  const es = new EventSource(`/api/progress/${jobId}`);
  currentEventSource = es;

  es.addEventListener('progress', (e) => {
    const data = JSON.parse(e.data);
    setProgress(data.percent, data.message);
  });

  es.addEventListener('resize', (e) => {
    const data = JSON.parse(e.data);
    resizeNotice.hidden = false;
    resizeNotice.textContent = '⚠️ ' + data.message;
  });

  es.addEventListener('complete', (e) => {
    const data = JSON.parse(e.data);
    es.close();
    currentEventSource = null;
    handleComplete(jobId, data);
  });

  es.addEventListener('error', (e) => {
    // Distinguish SSE connection error vs server-sent error event
    if (e.data) {
      const data = JSON.parse(e.data);
      es.close();
      currentEventSource = null;
      showError(data.message);
    } else {
      // SSE connection dropped — close and show generic error
      es.close();
      currentEventSource = null;
      showError('서버 연결이 끊어졌습니다. 다시 시도해주세요.');
    }
  });
}

/* ===== Handle Successful Conversion ===== */
function handleComplete(jobId, data) {
  // Build meta chips
  resultMeta.innerHTML = `
    <span class="meta-chip size">${data.sizeLabel}</span>
    <span class="meta-chip">${data.fps} FPS</span>
    <span class="meta-chip">${data.width > 0 ? data.width + 'px' : '원본'} 가로</span>
    <span class="meta-chip">${data.duration}초</span>
    <span class="meta-chip">트위터 업로드 가능</span>
  `;

  // Preview GIF
  gifPreview.src = `/api/download/${jobId}?preview=1`;

  // Download button
  downloadBtn.href = `/api/download/${jobId}`;
  downloadBtn.download = `gif_${jobId.slice(0, 8)}.gif`;

  showSection('result');
}

/* ===== Show Error ===== */
function showError(msg) {
  convertBtn.disabled = false;
  errorMessage.textContent = msg;
  showSection('error');
}

/* ===== Reset ===== */
[resetBtn, errorResetBtn].forEach(btn => {
  btn.addEventListener('click', resetApp);
});

function resetApp() {
  if (currentEventSource) {
    currentEventSource.close();
    currentEventSource = null;
  }

  selectedFile = null;
  fileInput.value = '';
  videoPreview.src = '';
  videoPreviewWrap.hidden = true;
  optionsPanel.hidden = true;
  gifPreview.src = '';
  downloadBtn.href = '#';
  resizeNotice.hidden = true;
  convertBtn.disabled = false;
  startTimeInput.value = '0';
  endTimeInput.value = '';
  fpsSlider.value = 15;
  fpsValue.textContent = '15';
  widthSelect.value = '480';

  showSection('upload');
}

/* ===== UI Helpers ===== */
function showSection(name) {
  uploadSection.hidden = name !== 'upload';
  progressSection.hidden = name !== 'progress';
  resultSection.hidden = name !== 'result';
  errorSection.hidden = name !== 'error';
}

function setProgress(percent, message) {
  progressBar.style.width = `${Math.max(2, percent)}%`;
  progressMessage.textContent = message || '';
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / 1024).toFixed(0) + ' KB';
}
