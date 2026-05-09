from __future__ import annotations

import base64
import datetime as dt
import ipaddress
import os
import random
import socket
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from flask import Flask, jsonify, render_template, request, send_file

app = Flask(__name__, static_folder="static", template_folder="templates")

FACE_CASCADE = cv2.CascadeClassifier(
    cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
)
if FACE_CASCADE.empty():
    raise RuntimeError("Could not load haarcascade_frontalface_default.xml")

UPPERBODY_PATH = cv2.data.haarcascades + "haarcascade_upperbody.xml"
UPPERBODY_CASCADE = cv2.CascadeClassifier(UPPERBODY_PATH) if Path(UPPERBODY_PATH).exists() else None
if UPPERBODY_CASCADE is not None and UPPERBODY_CASCADE.empty():
    UPPERBODY_CASCADE = None

_state_lock = threading.Lock()
_client_state: dict[str, dict[str, Any]] = {}
_ssl_context_cache: tuple[str, str] | None | bool = False
_certificate_source = "disabled"

BASE_DIR = Path(__file__).resolve().parent
CERT_DIR = BASE_DIR / "certs"
CA_CERT_PATH = CERT_DIR / "scouter-root-ca.pem"
CA_KEY_PATH = CERT_DIR / "scouter-root-ca-key.pem"
SERVER_CERT_PATH = CERT_DIR / "scouter-server-cert.pem"
SERVER_KEY_PATH = CERT_DIR / "scouter-server-key.pem"


@dataclass
class Metrics:
    brightness: float
    sharpness: float
    motion: float
    face_ratio: float
    centeredness: float
    body_ratio: float
    signal_strength: float


@dataclass
class Box:
    x: int
    y: int
    w: int
    h: int

    def area(self) -> int:
        return max(0, self.w) * max(0, self.h)



def env_flag(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}



def env_int(name: str, default: int) -> int:
    value = os.getenv(name)
    if value is None:
        return default
    try:
        return int(value)
    except ValueError:
        return default


APP_TITLE = os.getenv("SCOUTER_TITLE", "Udemy Scouter")
APP_HOST = os.getenv("SCOUTER_HOST", "0.0.0.0")
APP_PORT = env_int("SCOUTER_PORT", 5022)
APP_DEBUG = env_flag("SCOUTER_DEBUG", False)
APP_HTTPS = env_flag("SCOUTER_HTTPS", True)
APP_SSL_CERT = os.getenv("SCOUTER_SSL_CERT")
APP_SSL_KEY = os.getenv("SCOUTER_SSL_KEY")


@app.get("/")
def index() -> str:
    return render_template("index.html", app_title=APP_TITLE)


@app.get("/health")
def health() -> Any:
    ssl_context = resolve_ssl_context()
    return jsonify(
        {
            "ok": True,
            "title": APP_TITLE,
            "host": APP_HOST,
            "port": APP_PORT,
            "https": bool(ssl_context),
            "client_camera": True,
            "certificate_source": _certificate_source,
            "ca_download_url": "/ca-cert" if APP_HTTPS and CA_CERT_PATH.exists() else None,
            "access_urls": list_access_urls(APP_PORT, https=bool(ssl_context)),
        }
    )


@app.get("/ca-cert")
def ca_cert() -> Any:
    if not CA_CERT_PATH.exists():
        return jsonify({"ok": False, "error": "CA certificate is not available"}), 404
    return send_file(
        CA_CERT_PATH,
        mimetype="application/x-pem-file",
        as_attachment=True,
        download_name=CA_CERT_PATH.name,
    )


@app.post("/track")
def track() -> Any:
    return handle_analysis(mode="track")


@app.post("/analyze")
def analyze() -> Any:
    return handle_analysis(mode="measure")



def handle_analysis(mode: str) -> Any:
    payload = request.get_json(silent=True) or {}
    image_data = payload.get("image")

    if not image_data:
        return jsonify({"ok": False, "error": "image is required"}), 400

    try:
        frame = decode_data_url(image_data)
    except ValueError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400

    client_id = resolve_client_id(payload)
    result = analyze_frame(frame, client_id=client_id, mode=mode)
    return jsonify({"ok": True, **result})



def decode_data_url(data_url: str) -> np.ndarray:
    if "," not in data_url:
        raise ValueError("Invalid data URL")

    _, encoded = data_url.split(",", 1)
    try:
        binary = base64.b64decode(encoded)
    except Exception as exc:  # pragma: no cover - defensive
        raise ValueError("Base64 decode failed") from exc

    array = np.frombuffer(binary, dtype=np.uint8)
    frame = cv2.imdecode(array, cv2.IMREAD_COLOR)

    if frame is None:
        raise ValueError("Image decode failed")

    return frame



def resolve_client_id(payload: dict[str, Any]) -> str:
    client_id = str(payload.get("client_id") or "").strip()
    if client_id:
        return client_id[:120]

    forwarded_for = request.headers.get("X-Forwarded-For", "")
    if forwarded_for:
        return forwarded_for.split(",", 1)[0].strip()

    return request.remote_addr or "local"



def analyze_frame(frame: np.ndarray, client_id: str, mode: str) -> dict[str, Any]:
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    gray = cv2.equalizeHist(gray)

    h, w = gray.shape[:2]
    motion = calculate_motion(gray, client_id)
    face = detect_face(gray)
    upper_body = detect_upper_body(gray)
    face_detected = face is not None
    body_detected = upper_body is not None or face_detected

    if face is None and upper_body is None:
        fallback_power = max(8, int(18 + motion * 6 + random.randint(0, 22)))
        sharpness = float(cv2.Laplacian(gray, cv2.CV_64F).var())
        message = (
            "人物を検出できません。フレーム中央に入って計測開始してください。"
            if mode == "track"
            else "人物を検出できませんでした。距離と明るさを調整して再計測してください。"
        )
        return {
            "target_detected": False,
            "face_detected": False,
            "body_detected": False,
            "power_level": fallback_power,
            "class_name": "SEARCHING",
            "alert": None,
            "message": message,
            "bbox": None,
            "person_box": None,
            "outline_points": [],
            "metrics": {
                "brightness": round(float(gray.mean()), 1),
                "sharpness": round(sharpness, 1),
                "motion": round(motion, 1),
                "face_ratio": 0.0,
                "centeredness": 0.0,
                "body_ratio": 0.0,
                "signal_strength": 0.0,
            },
        }

    person_box = select_person_box(face, upper_body, w, h)
    if face is None:
        face = estimate_face_from_body(person_box, w, h)

    assert person_box is not None  # for type checkers
    assert face is not None

    fx, fy, fw, fh = face.x, face.y, face.w, face.h
    px, py, pw, ph = person_box.x, person_box.y, person_box.w, person_box.h

    face_roi = gray[fy : fy + fh, fx : fx + fw]
    if face_roi.size == 0:
        face_roi = gray[max(0, py) : min(h, py + ph), max(0, px) : min(w, px + pw)]

    brightness = float(face_roi.mean()) if face_roi.size else float(gray.mean())
    sharpness = float(cv2.Laplacian(face_roi, cv2.CV_64F).var()) if face_roi.size else float(cv2.Laplacian(gray, cv2.CV_64F).var())
    face_ratio = float((fw * fh) / float(w * h))
    body_ratio = float((pw * ph) / float(w * h))
    centeredness = calculate_centeredness(px, py, pw, ph, w, h)
    signal_strength = calculate_signal_strength(
        face_detected=face_detected,
        body_detected=body_detected,
        centeredness=centeredness,
        face_ratio=face_ratio,
        body_ratio=body_ratio,
        brightness=brightness,
        sharpness=sharpness,
    )

    metrics = Metrics(
        brightness=brightness,
        sharpness=sharpness,
        motion=motion,
        face_ratio=face_ratio,
        centeredness=centeredness,
        body_ratio=body_ratio,
        signal_strength=signal_strength,
    )
    power_level = score_power(metrics, face_detected=face_detected)

    alert = None
    if power_level >= 9000 or signal_strength >= 96:
        alert = "OVERLOAD"

    outline_points = build_outline_points(face, person_box, w, h)

    return {
        "target_detected": True,
        "face_detected": face_detected,
        "body_detected": body_detected,
        "power_level": power_level,
        "class_name": classify_power(power_level),
        "alert": alert,
        "message": message_for(power_level, alert, mode, face_detected),
        "bbox": normalize_box(face, w, h),
        "person_box": normalize_box(person_box, w, h),
        "outline_points": outline_points,
        "metrics": {
            "brightness": round(brightness, 1),
            "sharpness": round(sharpness, 1),
            "motion": round(motion, 1),
            "face_ratio": round(face_ratio, 4),
            "centeredness": round(centeredness, 3),
            "body_ratio": round(body_ratio, 4),
            "signal_strength": round(signal_strength, 1),
        },
    }



def detect_face(gray: np.ndarray) -> Box | None:
    faces = FACE_CASCADE.detectMultiScale(
        gray,
        scaleFactor=1.1,
        minNeighbors=5,
        minSize=(72, 72),
    )
    if faces is None or len(faces) == 0:
        return None
    x, y, w, h = max(faces, key=lambda rect: rect[2] * rect[3])
    return Box(int(x), int(y), int(w), int(h))



def detect_upper_body(gray: np.ndarray) -> Box | None:
    if UPPERBODY_CASCADE is None:
        return None

    bodies = UPPERBODY_CASCADE.detectMultiScale(
        gray,
        scaleFactor=1.08,
        minNeighbors=4,
        minSize=(120, 120),
    )
    if bodies is None or len(bodies) == 0:
        return None
    x, y, w, h = max(bodies, key=lambda rect: rect[2] * rect[3])
    return Box(int(x), int(y), int(w), int(h))



def select_person_box(face: Box | None, upper_body: Box | None, frame_width: int, frame_height: int) -> Box | None:
    if upper_body is not None:
        return expand_box(upper_body, frame_width, frame_height, grow_x=0.08, grow_y=0.12)
    if face is not None:
        return estimate_person_box_from_face(face, frame_width, frame_height)
    return None



def estimate_person_box_from_face(face: Box, frame_width: int, frame_height: int) -> Box:
    x = int(face.x - face.w * 0.9)
    y = int(face.y - face.h * 0.45)
    w = int(face.w * 2.8)
    h = int(face.h * 5.1)
    return clip_box(Box(x, y, w, h), frame_width, frame_height)



def estimate_face_from_body(person_box: Box, frame_width: int, frame_height: int) -> Box:
    x = int(person_box.x + person_box.w * 0.28)
    y = int(person_box.y + person_box.h * 0.04)
    w = int(person_box.w * 0.44)
    h = int(person_box.h * 0.28)
    return clip_box(Box(x, y, w, h), frame_width, frame_height)



def expand_box(box: Box, frame_width: int, frame_height: int, grow_x: float, grow_y: float) -> Box:
    extra_x = int(box.w * grow_x)
    extra_y = int(box.h * grow_y)
    return clip_box(Box(box.x - extra_x, box.y - extra_y, box.w + extra_x * 2, box.h + extra_y * 2), frame_width, frame_height)



def clip_box(box: Box, frame_width: int, frame_height: int) -> Box:
    x1 = max(0, box.x)
    y1 = max(0, box.y)
    x2 = min(frame_width, box.x + max(1, box.w))
    y2 = min(frame_height, box.y + max(1, box.h))
    return Box(x1, y1, max(1, x2 - x1), max(1, y2 - y1))



def normalize_box(box: Box, frame_width: int, frame_height: int) -> dict[str, float]:
    return {
        "x": round(box.x / frame_width, 4),
        "y": round(box.y / frame_height, 4),
        "w": round(box.w / frame_width, 4),
        "h": round(box.h / frame_height, 4),
    }



def build_outline_points(face: Box, person_box: Box, frame_width: int, frame_height: int) -> list[dict[str, float]]:
    cx = face.x + face.w / 2.0
    pts = [
        (cx, person_box.y),
        (face.x - face.w * 0.12, face.y + face.h * 0.10),
        (person_box.x + person_box.w * 0.14, person_box.y + person_box.h * 0.30),
        (person_box.x + person_box.w * 0.08, person_box.y + person_box.h * 0.58),
        (person_box.x + person_box.w * 0.22, person_box.y + person_box.h * 0.95),
        (person_box.x + person_box.w * 0.50, person_box.y + person_box.h),
        (person_box.x + person_box.w * 0.78, person_box.y + person_box.h * 0.95),
        (person_box.x + person_box.w * 0.92, person_box.y + person_box.h * 0.58),
        (person_box.x + person_box.w * 0.86, person_box.y + person_box.h * 0.30),
        (face.x + face.w * 1.12, face.y + face.h * 0.10),
    ]

    normalized: list[dict[str, float]] = []
    for px, py in pts:
        px = clamp(px, 0, frame_width)
        py = clamp(py, 0, frame_height)
        normalized.append(
            {
                "x": round(float(px) / frame_width, 4),
                "y": round(float(py) / frame_height, 4),
            }
        )
    return normalized



def calculate_motion(gray: np.ndarray, client_id: str) -> float:
    small = cv2.resize(gray, (160, 120))
    now = time.time()

    with _state_lock:
        cleanup_old_clients(now)
        previous = _client_state.get(client_id, {}).get("frame")
        _client_state[client_id] = {"frame": small, "updated_at": now}

    if previous is None:
        return 0.0

    diff = cv2.absdiff(previous, small)
    return float(diff.mean())



def cleanup_old_clients(now: float, ttl_seconds: int = 120) -> None:
    stale = [
        key
        for key, value in _client_state.items()
        if now - value.get("updated_at", 0) > ttl_seconds
    ]
    for key in stale:
        _client_state.pop(key, None)



def calculate_centeredness(
    x: int,
    y: int,
    fw: int,
    fh: int,
    frame_width: int,
    frame_height: int,
) -> float:
    cx = x + fw / 2.0
    cy = y + fh / 2.0
    dx = cx - frame_width / 2.0
    dy = cy - frame_height / 2.0
    distance = (dx * dx + dy * dy) ** 0.5
    max_distance = ((frame_width / 2.0) ** 2 + (frame_height / 2.0) ** 2) ** 0.5
    centeredness = 1.0 - (distance / max_distance)
    return clamp(centeredness, 0.0, 1.0)



def calculate_signal_strength(
    *,
    face_detected: bool,
    body_detected: bool,
    centeredness: float,
    face_ratio: float,
    body_ratio: float,
    brightness: float,
    sharpness: float,
) -> float:
    face_bonus = 24.0 if face_detected else 0.0
    body_bonus = 12.0 if body_detected else 0.0
    centering = centeredness * 24.0
    face_size = clamp(face_ratio * 840.0, 0.0, 18.0)
    body_size = clamp(body_ratio * 220.0, 0.0, 12.0)
    brightness_score = clamp((brightness - 45.0) * 0.16, 0.0, 10.0)
    sharpness_score = clamp(sharpness / 40.0, 0.0, 12.0)
    return round(min(100.0, face_bonus + body_bonus + centering + face_size + body_size + brightness_score + sharpness_score), 2)



def score_power(metrics: Metrics, face_detected: bool) -> int:
    base = 80
    body_score = min(metrics.body_ratio * 18000, 3500)
    face_score = min(metrics.face_ratio * 62000, 4200)
    center_bonus = metrics.centeredness * 580
    brightness_bonus = clamp((metrics.brightness - 50.0) * 9.0, 0.0, 950.0)
    sharpness_bonus = min(metrics.sharpness / 9.0, 850.0)
    motion_bonus = min(metrics.motion * 36.0, 750.0)
    signal_bonus = metrics.signal_strength * 28.0
    face_lock_bonus = 320 if face_detected else 0

    subtotal = (
        base
        + body_score
        + face_score
        + center_bonus
        + brightness_bonus
        + sharpness_bonus
        + motion_bonus
        + signal_bonus
        + face_lock_bonus
    )

    # 階層別の隠れた力倍率—個人差を極端に大きくする
    roll = random.random()
    if roll < 0.03:            # 3%  : 伝説級
        multiplier = random.uniform(6.0, 12.0)
    elif roll < 0.10:          # 7%  : 超エリート
        multiplier = random.uniform(2.8, 6.0)
    elif roll < 0.28:          # 18% : エリート
        multiplier = random.uniform(1.5, 2.8)
    elif roll < 0.55:          # 27% : 戦士クラス
        multiplier = random.uniform(0.85, 1.5)
    elif roll < 0.78:          # 23% : 一般人
        multiplier = random.uniform(0.35, 0.85)
    else:                      # 22% : 戦闘力ゼロに近い
        multiplier = random.uniform(0.05, 0.35)

    jitter = random.randint(-400, 800)
    power = int(subtotal * multiplier) + jitter
    return max(3, power)



def classify_power(power_level: int) -> str:
    if power_level < 150:
        return "CIVILIAN"
    if power_level < 600:
        return "WEAKLING"
    if power_level < 1800:
        return "SOLDIER"
    if power_level < 4500:
        return "FIGHTER"
    if power_level < 9000:
        return "ELITE"
    if power_level < 18000:
        return "OVERLOAD"
    return "LEGENDARY"



def message_for(power_level: int, alert: str | None, mode: str, face_detected: bool) -> str:
    if mode == "track":
        return "センサーが反応している……計測開始でスカウタースキャンを実行する。"
    if alert == "OVERLOAD":
        return "スカウターが壊れる！？こんな战闘力が……これはいったい何者なんだ！"
    if not face_detected:
        return "ボディシグナルを捕捉。顔ロックが弱い——正面を向けると精度が上がる。"
    if power_level < 150:
        return "戦闘力……三だ。現地下の雑魚以下だな、これは。"
    if power_level < 600:
        return "戦闘力が主りだな。訓練されていない戦士だ。"
    if power_level < 1800:
        return "これくらいなら……先に進めてやろう。一般戦士クラスだ。"
    if power_level < 4500:
        return "なかなかやるじゃないか！かなりの戦闘力だ。気をつけろ。"
    if power_level < 9000:
        return "こいつは強い！エリート戦士クラスの戦闘力だ。気を引き締めろ！"
    if power_level < 18000:
        return "バカな！戦闘力が……スカウターの限界を超えている！こんなやつが実在するのか！＿！"
    return "こ、こんな戦闘力が……こんなのあり得ない！これは本当に伝説級の戦士da！！"



def clamp(value: float | int, minimum: float | int, maximum: float | int) -> float:
    return float(max(minimum, min(value, maximum)))



def list_local_ipv4_addresses() -> list[str]:
    addresses: set[str] = {"127.0.0.1"}

    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None, socket.AF_INET, socket.SOCK_DGRAM):
            ip = info[4][0]
            if ip:
                addresses.add(ip)
    except OSError:
        pass

    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("8.8.8.8", 80))
            addresses.add(sock.getsockname()[0])
    except OSError:
        pass

    return sorted(addresses)



def list_access_urls(port: int, https: bool) -> list[str]:
    scheme = "https" if https else "http"
    return [f"{scheme}://{ip}:{port}" for ip in list_local_ipv4_addresses()]



def resolve_ssl_context() -> tuple[str, str] | None:
    global _ssl_context_cache
    global _certificate_source

    if _ssl_context_cache is not False:
        return _ssl_context_cache if isinstance(_ssl_context_cache, tuple) else None

    if not APP_HTTPS:
        _certificate_source = "disabled"
        _ssl_context_cache = None
        return None

    if APP_SSL_CERT and APP_SSL_KEY and Path(APP_SSL_CERT).exists() and Path(APP_SSL_KEY).exists():
        _certificate_source = "environment"
        _ssl_context_cache = (APP_SSL_CERT, APP_SSL_KEY)
        return _ssl_context_cache

    cert_path, key_path = ensure_dev_certificates()
    _certificate_source = "generated-ca"
    _ssl_context_cache = (str(cert_path), str(key_path))
    return _ssl_context_cache



def ensure_dev_certificates() -> tuple[Path, Path]:
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

    CERT_DIR.mkdir(parents=True, exist_ok=True)

    if CA_CERT_PATH.exists() and CA_KEY_PATH.exists():
        ca_cert = x509.load_pem_x509_certificate(CA_CERT_PATH.read_bytes())
        ca_key = serialization.load_pem_private_key(CA_KEY_PATH.read_bytes(), password=None)
    else:
        now = dt.datetime.now(dt.timezone.utc)
        ca_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        ca_subject = x509.Name(
            [
                x509.NameAttribute(NameOID.COUNTRY_NAME, "JP"),
                x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Udemy Scouter Dev CA"),
                x509.NameAttribute(NameOID.COMMON_NAME, "Udemy Scouter Root CA"),
            ]
        )
        ca_cert = (
            x509.CertificateBuilder()
            .subject_name(ca_subject)
            .issuer_name(ca_subject)
            .public_key(ca_key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - dt.timedelta(days=1))
            .not_valid_after(now + dt.timedelta(days=3650))
            .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
            .add_extension(
                x509.KeyUsage(
                    digital_signature=True,
                    content_commitment=False,
                    key_encipherment=False,
                    data_encipherment=False,
                    key_agreement=False,
                    key_cert_sign=True,
                    crl_sign=True,
                    encipher_only=False,
                    decipher_only=False,
                ),
                critical=True,
            )
            .sign(private_key=ca_key, algorithm=hashes.SHA256())
        )
        CA_CERT_PATH.write_bytes(ca_cert.public_bytes(serialization.Encoding.PEM))
        CA_KEY_PATH.write_bytes(
            ca_key.private_bytes(
                encoding=serialization.Encoding.PEM,
                format=serialization.PrivateFormat.TraditionalOpenSSL,
                encryption_algorithm=serialization.NoEncryption(),
            )
        )

    server_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    now = dt.datetime.now(dt.timezone.utc)
    local_ips = list_local_ipv4_addresses()
    sans: list[x509.GeneralName] = [
        x509.DNSName("localhost"),
        x509.DNSName(socket.gethostname()),
        x509.IPAddress(ipaddress.ip_address("127.0.0.1")),
    ]
    for ip in local_ips:
        try:
            sans.append(x509.IPAddress(ipaddress.ip_address(ip)))
        except ValueError:
            continue

    server_subject = x509.Name(
        [
            x509.NameAttribute(NameOID.COUNTRY_NAME, "JP"),
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Udemy Scouter"),
            x509.NameAttribute(NameOID.COMMON_NAME, "Udemy Scouter Local HTTPS"),
        ]
    )
    server_cert = (
        x509.CertificateBuilder()
        .subject_name(server_subject)
        .issuer_name(ca_cert.subject)
        .public_key(server_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - dt.timedelta(days=1))
        .not_valid_after(now + dt.timedelta(days=825))
        .add_extension(x509.SubjectAlternativeName(sans), critical=False)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                content_commitment=False,
                key_encipherment=True,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=False,
                crl_sign=False,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(
            x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]),
            critical=False,
        )
        .sign(private_key=ca_key, algorithm=hashes.SHA256())
    )

    SERVER_CERT_PATH.write_bytes(server_cert.public_bytes(serialization.Encoding.PEM))
    SERVER_KEY_PATH.write_bytes(
        server_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption(),
        )
    )
    return SERVER_CERT_PATH, SERVER_KEY_PATH



def print_startup_banner() -> None:
    ssl_context = resolve_ssl_context()
    scheme = "https" if ssl_context else "http"
    urls = list_access_urls(APP_PORT, https=bool(ssl_context))
    print("=" * 72)
    print(f"{APP_TITLE} starting on {scheme.upper()} {APP_HOST}:{APP_PORT}")
    for url in urls:
        print(f"  {url}")
    if APP_HTTPS and CA_CERT_PATH.exists():
        print(f"CA cert: {CA_CERT_PATH}")
    print("=" * 72)


if __name__ == "__main__":
    ssl_context = resolve_ssl_context()
    print_startup_banner()
    app.run(
        host=APP_HOST,
        port=APP_PORT,
        debug=APP_DEBUG,
        ssl_context=ssl_context,
    )
