#!/usr/bin/env python3
import sys, json, whisper, os

# 모델 캐싱을 위한 글로벌 변수
cached_models = {}

def load_model_cached(model_name):
    if model_name not in cached_models:
        print(f"모델 {model_name} 로딩 중...", file=sys.stderr)
        cached_models[model_name] = whisper.load_model(model_name)
    return cached_models[model_name]

# Usage: python3 transcribe.py <audio_path> <model> <lang>
audio_path = sys.argv[1]
model_name = sys.argv[2] if len(sys.argv) > 2 else "small"
lang = sys.argv[3] if len(sys.argv) > 3 else None

# 파일 크기 확인 (100MB 제한)
file_size = os.path.getsize(audio_path)
if file_size > 100 * 1024 * 1024:
    print(json.dumps({"error": "파일이 너무 큽니다 (100MB 제한)"}))
    sys.exit(1)

model = load_model_cached(model_name)
result = model.transcribe(audio_path, language=None if lang == "auto" else lang)

segments = []
for i, seg in enumerate(result["segments"], start=1):
    segments.append({
        "i": i,
        "start": round(seg["start"], 2),
        "end": round(seg["end"], 2),
        "text": seg["text"].strip()
    })

def fmt_time(t):
    ms = int((t - int(t)) * 1000)
    s = int(t) % 60
    m = (int(t) // 60) % 60
    h = int(t) // 3600
    return f"{h:02}:{m:02}:{s:02},{ms:03}"

srt_lines = []
for s in segments:
    srt_lines.append(str(s["i"]))
    srt_lines.append(f"{fmt_time(s['start'])} --> {fmt_time(s['end'])}")
    srt_lines.append(s["text"])
    srt_lines.append("")

srt = "\n".join(srt_lines)

print(json.dumps({
    "language": result.get("language"),
    "duration": result.get("duration"),
    "segments": segments,
    "srt": srt
}))
