from __future__ import annotations

import uuid
from pathlib import Path

import numpy as np
import soundfile as sf
from flask import Flask, flash, redirect, render_template, request, send_file, url_for
from scipy import signal
from werkzeug.utils import secure_filename

BASE_DIR = Path(__file__).resolve().parent
UPLOAD_DIR = BASE_DIR / "uploads"
OUTPUT_DIR = BASE_DIR / "outputs"
UPLOAD_DIR.mkdir(exist_ok=True)
OUTPUT_DIR.mkdir(exist_ok=True)

ALLOWED_EXTENSIONS = {"wav", "flac", "ogg", "aiff", "aif"}
MAX_SECONDS = 90

app = Flask(__name__)
app.secret_key = "dev-secret-change-me"
app.config["MAX_CONTENT_LENGTH"] = 100 * 1024 * 1024


def allowed_file(filename: str) -> bool:
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS


def to_mono(x: np.ndarray) -> np.ndarray:
    x = np.asarray(x)
    if x.ndim == 1:
        return x.astype(np.float32)
    return np.mean(x, axis=1).astype(np.float32)


def normalize(x: np.ndarray, peak: float = 0.95) -> np.ndarray:
    x = np.asarray(x, dtype=np.float32)
    if x.size == 0:
        return x
    m = float(np.max(np.abs(x)))
    if m < 1e-9:
        return x
    return (x / m * peak).astype(np.float32)


def safe_filter(sos: np.ndarray, x: np.ndarray) -> np.ndarray:
    """短い音声ではfiltfiltが失敗するので、その場合だけ片方向フィルタに逃がす。"""
    try:
        return signal.sosfiltfilt(sos, x).astype(np.float32)
    except ValueError:
        return signal.sosfilt(sos, x).astype(np.float32)


def bandpass(low_hz: float, high_hz: float, fs: int, order: int = 3) -> np.ndarray:
    nyq = fs * 0.5
    low_hz = max(20.0, min(float(low_hz), nyq - 100.0))
    high_hz = max(low_hz + 20.0, min(float(high_hz), nyq - 10.0))
    return signal.butter(order, [low_hz / nyq, high_hz / nyq], btype="bandpass", output="sos")


def lowpass(cut_hz: float, fs: int, order: int = 2) -> np.ndarray:
    nyq = fs * 0.5
    cut_hz = max(1.0, min(float(cut_hz), nyq - 1.0))
    return signal.butter(order, cut_hz / nyq, btype="lowpass", output="sos")


def make_carrier(t: np.ndarray, base_freq: float, tone: str, fs: int) -> np.ndarray:
    base_freq = float(np.clip(base_freq, 55.0, 440.0))

    if tone == "square":
        carrier = (
            signal.square(2 * np.pi * base_freq * t)
            + 0.45 * signal.square(2 * np.pi * base_freq * 1.5 * t)
            + 0.25 * signal.square(2 * np.pi * base_freq * 2.0 * t)
        )
    elif tone == "robot_sine":
        # 少し細く、昔のSFロボ声寄り
        carrier = (
            np.sin(2 * np.pi * base_freq * t)
            + 0.65 * np.sin(2 * np.pi * base_freq * 2.0 * t)
            + 0.35 * np.sin(2 * np.pi * base_freq * 3.0 * t)
        )
    elif tone == "r2d2":
        # R2-D2風: 細いホイッスルの音程をランダムに跳ね回らせる(ピヨピヨ/ピュイーン)。
        rng = np.random.default_rng()
        ratios = np.array([2.5, 3.2, 4.0, 5.0, 6.3, 8.0, 10.0, 12.5, 16.0])
        n = len(t)
        freq_curve = np.empty(n, dtype=np.float64)
        cur = base_freq * 4.0
        idx = 0
        while idx < n:
            seg = max(2, int((0.07 + rng.random() * 0.22) * fs))
            target = base_freq * float(rng.choice(ratios))
            end = min(idx + seg, n)
            glide_tc = max(1.0, (0.01 + rng.random() * 0.12) * fs)
            k = 1.0 - np.exp(-np.arange(end - idx) / glide_tc)
            freq_curve[idx:end] = cur + (target - cur) * k
            cur = float(freq_curve[end - 1])
            idx = end
        # 軽いビブラートを掛け、周波数を安全域にクリップする
        freq_curve *= 1.0 + 0.03 * np.sin(2 * np.pi * 6.2 * t)
        freq_curve = np.clip(freq_curve, 80.0, min(5000.0, fs * 0.45))
        # 瞬時周波数を積分して位相を作り、ホイッスル波形を生成する
        phase = 2.0 * np.pi * np.cumsum(freq_curve) / float(fs)
        carrier = np.sin(phase) + 0.25 * np.sin(2.0 * phase)
    else:
        # saw: レトロシンセ感。少しデチューンして厚みを出す。
        carrier = (
            signal.sawtooth(2 * np.pi * base_freq * t, width=0.52)
            + 0.55 * signal.sawtooth(2 * np.pi * base_freq * 1.006 * t, width=0.50)
            + 0.35 * signal.sawtooth(2 * np.pi * base_freq * 1.5 * t, width=0.50)
            + 0.20 * signal.sawtooth(2 * np.pi * base_freq * 2.0 * t, width=0.50)
        )

    return normalize(carrier, 0.85)


def vocoder(
    speech: np.ndarray,
    fs: int,
    base_freq: float = 110.0,
    bands: int = 16,
    tone: str = "saw",
    dry_mix: float = 0.03,
    brightness: float = 1.0,
    drive: float = 1.35,
) -> np.ndarray:
    if fs < 16000:
        raise ValueError("サンプリング周波数が低すぎます。16kHz以上のWAV/FLAC/OGGを使ってください。")

    speech = normalize(to_mono(speech), 0.85)
    if len(speech) < int(fs * 0.2):
        raise ValueError("音声が短すぎます。0.2秒以上の音声を指定してください。")

    bands = int(np.clip(bands, 8, 32))
    dry_mix = float(np.clip(dry_mix, 0.0, 0.20))
    brightness = float(np.clip(brightness, 0.5, 1.8))
    drive = float(np.clip(drive, 0.8, 3.0))

    # 低域のゴロゴロを軽く抑える
    hp = signal.butter(2, 50 / (fs * 0.5), btype="highpass", output="sos")
    speech_hp = safe_filter(hp, speech)

    t = np.arange(len(speech_hp), dtype=np.float32) / fs
    carrier = make_carrier(t, base_freq, tone, int(fs))

    # 古いチャンネル・ボコーダー風に対数間隔で帯域分割
    low = 90.0
    high = min(7200.0, fs * 0.5 - 400.0)
    if high <= low + 500:
        high = fs * 0.5 - 200.0
    edges = np.geomspace(low, high, bands + 1)

    env_smoother = lowpass(24.0, fs)
    out = np.zeros_like(speech_hp, dtype=np.float32)

    for i in range(bands):
        lo = float(edges[i])
        hi = float(edges[i + 1])
        sos = bandpass(lo, hi, fs)

        mod_band = safe_filter(sos, speech_hp)
        envelope = np.abs(signal.hilbert(mod_band)).astype(np.float32)
        envelope = safe_filter(env_smoother, envelope)

        # 包絡を少しコンプ気味にする。古い機械感が増す。
        envelope = np.sqrt(np.maximum(envelope, 0.0))
        ref = float(np.percentile(envelope, 98)) + 1e-8
        envelope = np.clip(envelope / ref, 0.0, 1.8)

        car_band = safe_filter(sos, carrier)

        # 高域をやや持ち上げると子音が残る
        high_boost = 0.85 + brightness * 0.45 * (i / max(1, bands - 1))
        out += envelope * car_band * high_boost

    # 少量の原音で日本語の明瞭度を補助
    out = out + dry_mix * speech_hp

    # 軽いサチュレーション
    out = np.tanh(out * drive)
    return normalize(out, 0.92)


@app.get("/")
def index():
    return render_template("index.html", result_url=None)


@app.post("/process")
def process():
    if "audio" not in request.files:
        flash("音声ファイルがありません。")
        return redirect(url_for("index"))

    f = request.files["audio"]
    if not f.filename:
        flash("ファイルを選択してください。")
        return redirect(url_for("index"))

    if not allowed_file(f.filename):
        flash("対応形式は WAV / FLAC / OGG / AIFF です。MP3は ffmpeg でWAVに変換してから使ってください。")
        return redirect(url_for("index"))

    original_name = secure_filename(f.filename)
    suffix = Path(original_name).suffix.lower()
    uid = uuid.uuid4().hex[:12]
    input_path = UPLOAD_DIR / f"input_{uid}{suffix}"
    output_path = OUTPUT_DIR / f"vocoder_{uid}.wav"
    f.save(input_path)

    try:
        base_freq = float(request.form.get("base_freq", 110))
        bands = int(request.form.get("bands", 16))
        tone = request.form.get("tone", "saw")
        dry_mix = float(request.form.get("dry_mix", 0.03))
        brightness = float(request.form.get("brightness", 1.0))
        drive = float(request.form.get("drive", 1.35))

        audio, fs = sf.read(str(input_path), always_2d=False)
        audio = to_mono(audio)

        max_samples = int(fs * MAX_SECONDS)
        if len(audio) > max_samples:
            audio = audio[:max_samples]

        y = vocoder(
            speech=audio,
            fs=int(fs),
            base_freq=base_freq,
            bands=bands,
            tone=tone,
            dry_mix=dry_mix,
            brightness=brightness,
            drive=drive,
        )
        sf.write(str(output_path), y, int(fs), subtype="PCM_16")

    except Exception as e:
        flash(f"処理に失敗しました: {e}")
        return redirect(url_for("index"))

    result_url = url_for("download", filename=output_path.name)
    return render_template("index.html", result_url=result_url)


@app.get("/download/<filename>")
def download(filename: str):
    path = OUTPUT_DIR / secure_filename(filename)
    if not path.exists():
        flash("出力ファイルが見つかりません。")
        return redirect(url_for("index"))
    return send_file(path, mimetype="audio/wav", as_attachment=False)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
