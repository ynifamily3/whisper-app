let player;
let currentRequest = null;
let transcriptSegments = [];
let translatedSegments = new Map();
let subtitleUpdateInterval = null;
let translator = null;
let translationEnabled = false;

window.onYouTubeIframeAPIReady = () => {
  /* created after submit */
};

function getVideoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname === "youtu.be") return u.pathname.slice(1).split("?")[0];
    if (u.searchParams.get("v")) return u.searchParams.get("v");
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts[0] === "embed" && parts[1]) return parts[1].split("?")[0];
  } catch {}
  return null;
}

function normalizeYouTubeUrl(url) {
  const videoId = getVideoId(url);
  return videoId ? `https://www.youtube.com/watch?v=${videoId}` : null;
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
      events: { onReady: () => resolve(player) },
    });
  });
}

async function transcribe(url, model, lang) {
  const controller = new AbortController();
  currentRequest = controller;
  const processId = Date.now().toString();

  // SSE 연결로 진행상황 실시간 수신
  const eventSource = new EventSource(`/api/progress/${processId}`);
  eventSource.onmessage = (event) => {
    const { step, progress, message } = JSON.parse(event.data);
    updateProgress(step, progress);
    if (message && step !== "completed") {
      showStatus(message, "info");
    }
  };

  try {
    const r = await fetch("/api/transcribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, model, lang, processId }),
      signal: controller.signal,
    });

    eventSource.close();

    if (!r.ok) {
      const errorText = await r.text();
      throw new Error(
        errorText.includes("error") ? JSON.parse(errorText).error : errorText
      );
    }
    return r.json();
  } catch (error) {
    eventSource.close();
    throw error;
  }
}

function renderTranscript(data) {
  const box = document.getElementById("transcript");
  box.innerHTML = "";
  
  // Store transcript segments for subtitle sync
  transcriptSegments = data.segments || [];
  
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
  
  // Start subtitle synchronization
  startSubtitleSync();
  
  // Show translation controls
  translationControls.style.display = "block";
}

function fmt(sec) {
  const s = Math.floor(sec % 60)
    .toString()
    .padStart(2, "0");
  const m = Math.floor((sec / 60) % 60)
    .toString()
    .padStart(2, "0");
  const h = Math.floor(sec / 3600)
    .toString()
    .padStart(2, "0");
  return `${h}:${m}:${s}`;
}

async function updateStickySubtitle() {
  if (!player || !player.getCurrentTime) return;
  
  const currentTime = player.getCurrentTime();
  const stickySubtitle = document.getElementById("stickySubtitle");
  const subtitleText = document.getElementById("currentSubtitleText");
  
  // Find the current subtitle segment
  const currentSegmentIndex = transcriptSegments.findIndex(segment => 
    currentTime >= segment.start && currentTime <= segment.end
  );
  
  if (currentSegmentIndex !== -1) {
    const currentSegment = transcriptSegments[currentSegmentIndex];
    
    if (translationEnabled && translator) {
      // Show both original and translated text
      const translatedText = await translateSegment(currentSegment.text, currentSegmentIndex);
      
      subtitleText.innerHTML = `
        <div class="subtitle-dual">
          <span class="subtitle-original">${currentSegment.text}</span>
          <span class="subtitle-translated">${translatedText}</span>
        </div>
      `;
    } else {
      // Show only original text
      subtitleText.textContent = currentSegment.text;
    }
    
    stickySubtitle.style.display = "flex";
  } else {
    stickySubtitle.style.display = "none";
  }
}

function startSubtitleSync() {
  if (subtitleUpdateInterval) {
    clearInterval(subtitleUpdateInterval);
  }
  
  // Update subtitle every 100ms for smooth sync
  subtitleUpdateInterval = setInterval(updateStickySubtitle, 100);
}

function stopSubtitleSync() {
  if (subtitleUpdateInterval) {
    clearInterval(subtitleUpdateInterval);
    subtitleUpdateInterval = null;
  }
  
  const stickySubtitle = document.getElementById("stickySubtitle");
  stickySubtitle.style.display = "none";
}

// Chrome Translator API functions
async function initializeTranslator() {
  try {
    // Check if Translation API is available
    if (!('ai' in window) || !('translator' in window.ai)) {
      throw new Error('Translation API not available');
    }

    const canTranslate = await window.ai.translator.canTranslate({
      sourceLanguage: document.getElementById("sourceLanguage").value,
      targetLanguage: document.getElementById("targetLanguage").value
    });

    if (canTranslate !== 'no') {
      if (canTranslate === 'readily') {
        translator = await window.ai.translator.create({
          sourceLanguage: document.getElementById("sourceLanguage").value,
          targetLanguage: document.getElementById("targetLanguage").value
        });
      } else {
        // Need to download the model
        showStatus("번역 모델 다운로드 중...", "info");
        translator = await window.ai.translator.create({
          sourceLanguage: document.getElementById("sourceLanguage").value,
          targetLanguage: document.getElementById("targetLanguage").value
        });
        await translator.ready;
      }
      return true;
    } else {
      showStatus("선택한 언어 조합은 번역을 지원하지 않습니다.", "error");
      return false;
    }
  } catch (error) {
    console.error("Translation API error:", error);
    showStatus("번역 기능이 지원되지 않는 브라우저입니다. Chrome 최신 버전을 사용하세요.", "error");
    return false;
  }
}

async function translateSegment(text, segmentId) {
  if (!translator || !text.trim()) return text;
  
  try {
    // Check cache first
    if (translatedSegments.has(segmentId)) {
      return translatedSegments.get(segmentId);
    }
    
    const translated = await translator.translate(text);
    translatedSegments.set(segmentId, translated);
    return translated;
  } catch (error) {
    console.error("Translation error:", error);
    return text;
  }
}

async function translateAllSegments() {
  if (!translator || !transcriptSegments.length) return;
  
  showStatus("자막 번역 중...", "info");
  
  for (let i = 0; i < transcriptSegments.length; i++) {
    const segment = transcriptSegments[i];
    await translateSegment(segment.text, i);
    
    // Update progress
    if (i % 5 === 0 || i === transcriptSegments.length - 1) {
      const progress = ((i + 1) / transcriptSegments.length) * 100;
      showStatus(`자막 번역 중... ${Math.round(progress)}%`, "info");
    }
  }
  
  showStatus("자막 번역 완료!", "success");
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

// Translation elements
const toggleTranslationBtn = document.getElementById("toggleTranslation");
const translationControls = document.getElementById("translationControls");
const sourceLanguageEl = document.getElementById("sourceLanguage");
const targetLanguageEl = document.getElementById("targetLanguage");

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
    starting: "처리를 준비 중...",
    downloading: "영상 다운로드 중...",
    transcribing: "음성을 텍스트로 변환 중...",
    generating: "자막 파일 생성 중...",
    completed: "완료!",
  };
  progressText.textContent = steps[step] || step;
  progressFill.style.width = `${progress}%`;
}

function showStatus(message, type = "info") {
  statusEl.className = type;
  statusEl.textContent = message;
}

cancelBtn.addEventListener("click", () => {
  if (currentRequest) {
    currentRequest.abort();
    hideProgress();
    stopSubtitleSync();
    showStatus("작업이 취소되었습니다.", "error");
  }
});

// Translation toggle functionality
toggleTranslationBtn.addEventListener("click", async () => {
  if (!translationEnabled) {
    // Enable translation
    toggleTranslationBtn.disabled = true;
    toggleTranslationBtn.textContent = "번역 준비 중...";
    
    const success = await initializeTranslator();
    if (success) {
      translationEnabled = true;
      toggleTranslationBtn.textContent = "번역 끄기";
      toggleTranslationBtn.classList.add("active");
      
      // Pre-translate all segments for better performance
      await translateAllSegments();
    } else {
      toggleTranslationBtn.textContent = "번역 켜기";
    }
    toggleTranslationBtn.disabled = false;
  } else {
    // Disable translation
    translationEnabled = false;
    toggleTranslationBtn.textContent = "번역 켜기";
    toggleTranslationBtn.classList.remove("active");
    
    // Clean up translator
    if (translator) {
      translator.destroy?.();
      translator = null;
    }
    translatedSegments.clear();
  }
});

// Language change handlers
sourceLanguageEl.addEventListener("change", () => {
  if (translationEnabled) {
    translationEnabled = false;
    toggleTranslationBtn.textContent = "번역 켜기";
    toggleTranslationBtn.classList.remove("active");
    if (translator) {
      translator.destroy?.();
      translator = null;
    }
    translatedSegments.clear();
  }
});

targetLanguageEl.addEventListener("change", () => {
  if (translationEnabled) {
    translationEnabled = false;
    toggleTranslationBtn.textContent = "번역 켜기";
    toggleTranslationBtn.classList.remove("active");
    if (translator) {
      translator.destroy?.();
      translator = null;
    }
    translatedSegments.clear();
  }
});

go.addEventListener("click", async () => {
  const inputUrl = urlEl.value.trim();
  const vid = getVideoId(inputUrl);

  if (!vid) {
    return showStatus("올바른 유튜브 URL을 입력해주세요.", "error");
  }

  // URL 정규화
  const normalizedUrl = normalizeYouTubeUrl(inputUrl);
  if (inputUrl !== normalizedUrl) {
    urlEl.value = normalizedUrl;
    showStatus(`URL이 정규화되었습니다: ${normalizedUrl}`, "info");
    setTimeout(() => showStatus("처리를 시작합니다...", "info"), 1000);
  }

  showProgress();
  updateProgress("starting", 10);
  showStatus("처리를 시작합니다...", "info");
  
  // Stop any existing subtitle sync and reset translation
  stopSubtitleSync();
  translationControls.style.display = "none";
  if (translationEnabled) {
    translationEnabled = false;
    toggleTranslationBtn.textContent = "번역 켜기";
    toggleTranslationBtn.classList.remove("active");
    if (translator) {
      translator.destroy?.();
      translator = null;
    }
    translatedSegments.clear();
  }

  await ensurePlayer(vid);

  try {
    // SSE가 진행상황을 실시간으로 업데이트합니다
    const data = await transcribe(normalizedUrl, modelEl.value, langEl.value);

    if (data.cached) {
      showStatus("캐시에서 불러왔습니다!", "info");
    }

    const duration = Math.round(data.duration || 0);
    const language = data.language || "알 수 없음";
    const cacheStatus = data.cached ? " (캐시됨)" : "";
    showStatus(
      `완료! 영상 길이: ${duration}초, 언어: ${language}${cacheStatus}`,
      "success"
    );

    renderTranscript(data);
    hideProgress();
  } catch (e) {
    hideProgress();
    if (e.name === "AbortError") {
      showStatus("작업이 취소되었습니다.", "error");
    } else {
      const friendlyErrors = {
        "Invalid URL": "올바른 유튜브 URL을 입력해주세요.",
        "yt-dlp did not produce audio.mp3":
          "영상 다운로드에 실패했습니다. 다른 영상을 시도해보세요.",
        "영상 다운로드에 실패했습니다. URL을 확인해주세요":
          "영상을 찾을 수 없습니다. URL을 확인해주세요.",
        "파일이 너무 큽니다 (100MB 제한)":
          "영상이 너무 큽니다. 더 짧은 영상을 시도해보세요.",
        "서버가 바쁩니다. 잠시 후 다시 시도해주세요":
          "서버가 바쁩니다. 잠시 후 다시 시도해주세요.",
        "Network error": "네트워크 연결을 확인해주세요.",
      };
      const errorMsg =
        friendlyErrors[e.message] || `오류가 발생했습니다: ${e.message}`;
      showStatus(errorMsg, "error");
    }
  }
});
