import express from "express";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(process.cwd(), "public")));

// 동시 요청 제한
let activeRequests = 0;
const MAX_CONCURRENT_REQUESTS = 3;

// 캐시 시스템
const transcriptCache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24시간
const CACHE_MAX_SIZE = 100; // 최대 100개 항목

function generateCacheKey(url, model, lang) {
  return crypto.createHash('sha256').update(`${url}:${model}:${lang}`).digest('hex');
}

function cleanupCache() {
  if (transcriptCache.size <= CACHE_MAX_SIZE) return;
  
  // 오래된 항목부터 삭제
  const entries = Array.from(transcriptCache.entries());
  entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
  
  const toDelete = entries.slice(0, transcriptCache.size - CACHE_MAX_SIZE);
  toDelete.forEach(([key]) => transcriptCache.delete(key));
}

app.get("/health", (_, res) => res.json({ ok: true }));

// 캐시 상태 조회 API
app.get("/api/cache/stats", (_, res) => {
  res.json({
    size: transcriptCache.size,
    maxSize: CACHE_MAX_SIZE,
    ttl: CACHE_TTL / (60 * 60 * 1000) + "시간"
  });
});

// Server-Sent Events for progress tracking
const activeProcesses = new Map();

app.get("/api/progress/:processId", (req, res) => {
  const processId = req.params.processId;
  
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  activeProcesses.set(processId, res);
  
  req.on('close', () => {
    activeProcesses.delete(processId);
  });
});

function sendProgress(processId, step, progress, message) {
  const res = activeProcesses.get(processId);
  if (res) {
    res.write(`data: ${JSON.stringify({ step, progress, message })}\n\n`);
  }
}

// POST /api/transcribe { url, lang?, model?, processId? }
app.post("/api/transcribe", async (req, res) => {
  const { url, lang = "auto", model = "small", processId } = req.body || {};
  
  // URL 검증 강화
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: "URL이 필요합니다" });
  }
  
  try {
    const parsedUrl = new URL(url);
    const validHosts = ['www.youtube.com', 'youtube.com', 'youtu.be', 'm.youtube.com'];
    if (!validHosts.includes(parsedUrl.hostname)) {
      return res.status(400).json({ error: "유튜브 URL만 지원합니다" });
    }
  } catch {
    return res.status(400).json({ error: "올바른 URL 형식이 아닙니다" });
  }
  
  // 모델 검증
  const validModels = ['tiny', 'base', 'small', 'medium', 'large-v2'];
  if (!validModels.includes(model)) {
    return res.status(400).json({ error: "지원하지 않는 모델입니다" });
  }
  
  // 언어 검증
  const validLangs = ['auto', 'ko', 'en', 'ja', 'zh'];
  if (!validLangs.includes(lang)) {
    return res.status(400).json({ error: "지원하지 않는 언어입니다" });
  }

  // 동시 요청 수 확인
  if (activeRequests >= MAX_CONCURRENT_REQUESTS) {
    return res.status(429).json({ error: "서버가 바쁩니다. 잠시 후 다시 시도해주세요" });
  }

  activeRequests++;
  
  // 캐시 확인
  const cacheKey = generateCacheKey(url, model, lang);
  const cached = transcriptCache.get(cacheKey);
  
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    console.log(`[${new Date().toISOString()}] 캐시 히트: ${url}`);
    if (processId) sendProgress(processId, 'completed', 100, '캐시에서 불러왔습니다!');
    activeRequests--;
    return res.json({ ok: true, ...cached.data, cached: true });
  }
  
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "ytw-"));
  const audioPath = path.join(work, "audio.mp3");

  try {
    console.log(`[${new Date().toISOString()}] 처리 시작: ${url}, 모델: ${model}, 언어: ${lang}`);
    if (processId) sendProgress(processId, 'downloading', 20, '영상 다운로드 중...');
    
    // 1) yt-dlp: extract audio as MP3
    const ytdlpArgs = [
      "-x",
      "--audio-format", "mp3",
      url,
      "-o", "audio.%(ext)s", // produces audio.mp3
      "--max-filesize", "100M" // 파일 크기 제한
    ];
    console.log(`[${new Date().toISOString()}] yt-dlp 시작`);
    await runCmd("yt-dlp", ytdlpArgs, { cwd: work });
    
    if (!fs.existsSync(audioPath)) {
      throw new Error("영상 다운로드에 실패했습니다. URL을 확인해주세요");
    }
    
    console.log(`[${new Date().toISOString()}] 오디오 추출 완료: ${fs.statSync(audioPath).size} bytes`);
    if (processId) sendProgress(processId, 'transcribing', 60, '음성을 텍스트로 변환 중...');

    // 2) python faster-whisper
    const pyArgs = [path.join(process.cwd(), "transcribe.py"), audioPath, model, lang];
    console.log(`[${new Date().toISOString()}] Whisper 전사 시작`);
    const { stdout } = await runCmd("python3", pyArgs, { cwd: work });
    const out = JSON.parse(stdout.toString());
    
    if (out.error) {
      throw new Error(out.error);
    }
    
    console.log(`[${new Date().toISOString()}] 전사 완료: ${out.segments?.length || 0} 세그먼트`);
    if (processId) sendProgress(processId, 'generating', 90, '자막 생성 중...');

    // 캐시에 저장
    transcriptCache.set(cacheKey, {
      data: out,
      timestamp: Date.now()
    });
    cleanupCache();

    // 3) cleanup temp dir
    safeRm(work);

    if (processId) sendProgress(processId, 'completed', 100, '완료!');
    res.json({ ok: true, ...out, cached: false });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] 처리 오류:`, err);
    res.status(500).json({ error: String(err.message || err) });
  } finally {
    activeRequests--;
    safeRm(work);
  }
});

function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    child.stdout.on("data", (d) => (stdout = Buffer.concat([stdout, d])));
    child.stderr.on("data", (d) => (stderr = Buffer.concat([stderr, d])));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exited with ${code}: ${stderr.toString()}`));
    });
  });
}

function safeRm(target) {
  try { fs.rmSync(target, { recursive: true, force: true }); } catch {}
}

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`▶ Listening on http://localhost:${port}`));
