let player;
let currentRequest = null;
window.onYouTubeIframeAPIReady = () => { /* created after submit */ };

function getVideoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname === "youtu.be") return u.pathname.slice(1);
    if (u.searchParams.get("v")) return u.searchParams.get("v");
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts[0] === "embed" && parts[1]) return parts[1];
  } catch {}
  return null;
}

function ensurePlayer(videoId) {
  return new Promise((resolve) => {
    if (player) {
      player.loadVideoById(videoId);
      return resolve(player);
    }
    player = new YT.Player("player", {
      height: "360",
      width: "640",
      videoId,
      playerVars: { playsinline: 1 },
      events: { onReady: () => resolve(player) }
    });
  });
}

async function transcribe(url, model, lang) {
  const controller = new AbortController();
  currentRequest = controller;
  
  const r = await fetch("/api/transcribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, model, lang }),
    signal: controller.signal
  });
  if (!r.ok) {
    const errorText = await r.text();
    throw new Error(errorText.includes('error') ? JSON.parse(errorText).error : errorText);
  }
  return r.json();
}

function renderTranscript(data) {
  const box = document.getElementById("transcript");
  box.innerHTML = "";
  data.segments.forEach((s) => {
    const div = document.createElement("div");
    div.className = "seg";
    const t = document.createElement("span");
    t.className = "time";
    t.textContent = `[${fmt(s.start)}–${fmt(s.end)}]`;
    const txt = document.createElement("span");
    txt.textContent = s.text;
    div.appendChild(t);
    div.appendChild(txt);
    div.addEventListener("click", () => {
      if (player && player.seekTo) player.seekTo(s.start, true);
    });
    box.appendChild(div);
  });

  const btn = document.getElementById("downloadSrt");
  btn.disabled = false;
  btn.onclick = () => {
    const blob = new Blob([data.srt], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "자막.srt";
    a.click();
    URL.revokeObjectURL(a.href);
  };
}

function fmt(sec) {
  const s = Math.floor(sec % 60).toString().padStart(2, "0");
  const m = Math.floor((sec / 60) % 60).toString().padStart(2, "0");
  const h = Math.floor(sec / 3600).toString().padStart(2, "0");
  return `${h}:${m}:${s}`;
}

const go = document.getElementById("go");
const urlEl = document.getElementById("url");
const modelEl = document.getElementById("model");
const langEl = document.getElementById("lang");
const statusEl = document.getElementById("status");
const progressContainer = document.getElementById("progressContainer");
const progressText = document.getElementById("progressText");
const progressFill = document.getElementById("progressFill");
const cancelBtn = document.getElementById("cancelBtn");

function showProgress() {
  progressContainer.style.display = "block";
  go.disabled = true;
  urlEl.disabled = true;
  modelEl.disabled = true;
  langEl.disabled = true;
}

function hideProgress() {
  progressContainer.style.display = "none";
  go.disabled = false;
  urlEl.disabled = false;
  modelEl.disabled = false;
  langEl.disabled = false;
  currentRequest = null;
}

function updateProgress(step, progress = 0) {
  const steps = {
    'downloading': '영상 다운로드 중...',
    'transcribing': '음성을 텍스트로 변환 중...',
    'processing': '자막 생성 중...'
  };
  progressText.textContent = steps[step] || step;
  progressFill.style.width = `${progress}%`;
}

function showStatus(message, type = 'info') {
  statusEl.className = type;
  statusEl.textContent = message;
}

cancelBtn.addEventListener("click", () => {
  if (currentRequest) {
    currentRequest.abort();
    hideProgress();
    showStatus("작업이 취소되었습니다.", 'error');
  }
});

go.addEventListener("click", async () => {
  const url = urlEl.value.trim();
  const vid = getVideoId(url);
  
  if (!vid) {
    return showStatus("올바른 유튜브 URL을 입력해주세요.", 'error');
  }

  showProgress();
  updateProgress('downloading', 10);
  showStatus("처리를 시작합니다...", 'info');
  
  await ensurePlayer(vid);
  
  try {
    updateProgress('downloading', 30);
    const data = await transcribe(url, modelEl.value, langEl.value);
    
    if (data.cached) {
      updateProgress('processing', 100);
      showStatus("캐시에서 불러왔습니다!", 'info');
    } else {
      updateProgress('processing', 100);
    }
    
    const duration = Math.round(data.duration || 0);
    const language = data.language || '알 수 없음';
    const cacheStatus = data.cached ? ' (캐시됨)' : '';
    showStatus(`완료! 영상 길이: ${duration}초, 언어: ${language}${cacheStatus}`, 'success');
    
    renderTranscript(data);
    hideProgress();
  } catch (e) {
    hideProgress();
    if (e.name === 'AbortError') {
      showStatus("작업이 취소되었습니다.", 'error');
    } else {
      const friendlyErrors = {
        'Invalid URL': '올바른 유튜브 URL을 입력해주세요.',
        'yt-dlp did not produce audio.mp3': '영상 다운로드에 실패했습니다. 다른 영상을 시도해보세요.',
        '영상 다운로드에 실패했습니다. URL을 확인해주세요': '영상을 찾을 수 없습니다. URL을 확인해주세요.',
        '파일이 너무 큽니다 (100MB 제한)': '영상이 너무 큽니다. 더 짧은 영상을 시도해보세요.',
        '서버가 바쁩니다. 잠시 후 다시 시도해주세요': '서버가 바쁩니다. 잠시 후 다시 시도해주세요.',
        'Network error': '네트워크 연결을 확인해주세요.',
      };
      const errorMsg = friendlyErrors[e.message] || `오류가 발생했습니다: ${e.message}`;
      showStatus(errorMsg, 'error');
    }
  }
});
