const video = document.getElementById("video");
const overlay = document.getElementById("overlay");
const viewerFrame = document.getElementById("viewerFrame");
const startBtn = document.getElementById("startBtn");
const scanBtn = document.getElementById("scanBtn");
const cameraSelect = document.getElementById("cameraSelect");
const connectionChip = document.getElementById("connectionChip");
const stateChip = document.getElementById("stateChip");
const powerValue = document.getElementById("powerValue");
const classValue = document.getElementById("classValue");
const lockValue = document.getElementById("lockValue");
const modeValue = document.getElementById("modeValue");
const messageBox = document.getElementById("messageBox");
const risingColumn = document.getElementById("risingColumn");

const captureCanvas = document.createElement("canvas");
const CAPTURE_MAX_WIDTH = 960;
const SOUND_EFFECT_2_URL = "/static/Sound_effect_2.mp3";

let audioCtx = null;
let hudAnimationId = null;
let trackTimerId = null;
let powerAnimationId = null;
let trackingBusy = false;
let soundEffect2Buffer = null;
let soundEffect2BufferPromise = null;
let soundEffect2Sources = [];
let risingNumberInterval = null;

const appState = {
  clientId: getOrCreateClientId(),
  streamReady: false,
  scanning: false,
  booting: false,
  displayPower: 0,
  candidatePower: 0,
  bbox: null,
  personBox: null,
  outlinePoints: [],
  className: "STANDBY",
  alert: null,
  scanProgress: 0,
};

function getOrCreateClientId() {
  const key = "udemy-scouter-client-id";
  let value = window.localStorage.getItem(key);
  if (!value) {
    value = globalThis.crypto?.randomUUID?.() || `scouter-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    window.localStorage.setItem(key, value);
  }
  return value;
}

async function populateCameraList(selectDeviceId) {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoDevices = devices.filter((d) => d.kind === "videoinput" && d.deviceId);
    if (videoDevices.length === 0) {
      return;
    }
    const prevValue = selectDeviceId || cameraSelect.value;
    cameraSelect.innerHTML = "";
    videoDevices.forEach((device, index) => {
      const label = device.label || `\u30ab\u30e1\u30e9 ${index + 1}`;
      const opt = new Option(label, device.deviceId);
      cameraSelect.appendChild(opt);
    });
    if (prevValue && [...cameraSelect.options].some((o) => o.value === prevValue)) {
      cameraSelect.value = prevValue;
    } else {
      cameraSelect.selectedIndex = 0;
    }
  } catch (error) {
    console.error("Camera enumeration failed:", error);
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function lerp(start, end, t) {
  return start + (end - start) * t;
}

function formatPower(value) {
  return Math.max(0, Math.round(value)).toLocaleString("ja-JP");
}

function wait(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function resizeOverlay() {
  const rect = overlay.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  overlay.width = Math.max(1, Math.floor(rect.width * ratio));
  overlay.height = Math.max(1, Math.floor(rect.height * ratio));
}

function getVideoContentRect() {
  const videoWidth = video.videoWidth || 16;
  const videoHeight = video.videoHeight || 9;
  const canvasWidth = overlay.width || 1;
  const canvasHeight = overlay.height || 1;
  const scale = Math.max(canvasWidth / videoWidth, canvasHeight / videoHeight);
  const width = videoWidth * scale;
  const height = videoHeight * scale;
  return {
    x: (canvasWidth - width) / 2,
    y: (canvasHeight - height) / 2,
    width,
    height,
  };
}

function normalizedBoxToCanvas(box) {
  if (!box) {
    return null;
  }

  const rect = getVideoContentRect();
  return {
    x: rect.x + box.x * rect.width,
    y: rect.y + box.y * rect.height,
    w: box.w * rect.width,
    h: box.h * rect.height,
  };
}

function normalizedPointToCanvas(point) {
  const rect = getVideoContentRect();
  return {
    x: rect.x + point.x * rect.width,
    y: rect.y + point.y * rect.height,
  };
}

function drawFrameGuide(ctx, width, height) {
  const pad = 22;
  const len = 28;
  ctx.save();
  ctx.strokeStyle = "rgba(137, 255, 179, 0.42)";
  ctx.lineWidth = 2;
  [[pad, pad], [width - pad, pad], [pad, height - pad], [width - pad, height - pad]].forEach(([x, y], index) => {
    const dx = index === 1 || index === 3 ? -1 : 1;
    const dy = index >= 2 ? -1 : 1;
    ctx.beginPath();
    ctx.moveTo(x, y + len * dy);
    ctx.lineTo(x, y);
    ctx.lineTo(x + len * dx, y);
    ctx.stroke();
  });

  ctx.strokeStyle = "rgba(137, 255, 179, 0.18)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(width / 2, pad + 12);
  ctx.lineTo(width / 2, height - pad - 12);
  ctx.moveTo(pad + 12, height / 2);
  ctx.lineTo(width - pad - 12, height / 2);
  ctx.stroke();
  ctx.restore();
}

function drawSweep(ctx, width, height, now) {
  const lineY = ((now / 5.5) % (height + 120)) - 60;
  const gradient = ctx.createLinearGradient(0, lineY - 16, 0, lineY + 16);
  gradient.addColorStop(0, "rgba(72, 255, 146, 0)");
  gradient.addColorStop(0.5, appState.scanning ? "rgba(72, 255, 146, 0.32)" : "rgba(72, 255, 146, 0.12)");
  gradient.addColorStop(1, "rgba(72, 255, 146, 0)");
  ctx.save();
  ctx.fillStyle = gradient;
  ctx.fillRect(0, lineY - 16, width, 32);
  ctx.restore();
}

function drawPersonOutline(ctx, now) {
  if (!appState.outlinePoints?.length) {
    return;
  }

  const points = appState.outlinePoints.map(normalizedPointToCanvas);
  if (points.length < 3) {
    return;
  }

  const isOverload = appState.alert === "OVERLOAD";
  const pulse = 0.82 + Math.sin(now / 180) * 0.12;

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let index = 1; index < points.length; index += 1) {
    ctx.lineTo(points[index].x, points[index].y);
  }
  ctx.closePath();

  // Outer glow pass
  ctx.strokeStyle = isOverload ? "rgba(255, 100, 100, 0.5)" : "rgba(72, 255, 146, 0.45)";
  ctx.lineWidth = appState.scanning ? 12 : 9;
  ctx.shadowColor = isOverload ? "rgba(255, 80, 80, 0.7)" : "rgba(72, 255, 146, 0.7)";
  ctx.shadowBlur = appState.scanning ? 28 : 20;
  ctx.stroke();

  // Sharp inner pass
  ctx.strokeStyle = isOverload ? `rgba(255, 160, 160, ${pulse})` : `rgba(190, 255, 215, ${pulse})`;
  ctx.lineWidth = appState.scanning ? 2.8 : 2.2;
  ctx.shadowBlur = 0;
  ctx.stroke();

  ctx.restore();
}

function drawScouterReticle(ctx, now, box) {
  if (!box) {
    return;
  }

  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const r = Math.max(box.w, box.h) * 0.58;
  const isOverload = appState.alert === "OVERLOAD";
  const spin = (now / 1400) % (Math.PI * 2);
  const spinBack = -(now / 900) % (Math.PI * 2);
  const pulse = 0.55 + Math.sin(now / 220) * 0.45;
  const [cr, cg, cb] = isOverload ? [255, 65, 65] : [72, 255, 146];
  const color = (a) => `rgba(${cr}, ${cg}, ${cb}, ${a})`;

  ctx.save();

  // Outer ring - glow + sharp
  ctx.shadowColor = color(0.85);
  ctx.shadowBlur = appState.scanning ? 36 : 22;
  ctx.strokeStyle = color(0.48 * pulse);
  ctx.lineWidth = appState.scanning ? 3.5 : 2.5;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();

  // Inner ring
  ctx.shadowBlur = 6;
  ctx.strokeStyle = color(0.28);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.68, 0, Math.PI * 2);
  ctx.stroke();

  // Rotating tick marks (outer ring)
  ctx.shadowBlur = 0;
  const tickCount = appState.scanning ? 32 : 20;
  for (let i = 0; i < tickCount; i++) {
    const angle = (i / tickCount) * Math.PI * 2 + spin;
    const isMain = i % (appState.scanning ? 8 : 5) === 0;
    const innerFrac = isMain ? 0.82 : 0.91;
    const x1 = cx + Math.cos(angle) * r * innerFrac;
    const y1 = cy + Math.sin(angle) * r * innerFrac;
    const x2 = cx + Math.cos(angle) * r;
    const y2 = cy + Math.sin(angle) * r;
    ctx.beginPath();
    ctx.strokeStyle = color(isMain ? 0.95 : 0.42);
    ctx.lineWidth = isMain ? 2.8 : 1.2;
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  // Counter-rotating inner ticks (scanning only)
  if (appState.scanning) {
    for (let i = 0; i < 12; i++) {
      const angle = (i / 12) * Math.PI * 2 + spinBack;
      const x1 = cx + Math.cos(angle) * r * 0.63;
      const y1 = cy + Math.sin(angle) * r * 0.63;
      const x2 = cx + Math.cos(angle) * r * 0.68;
      const y2 = cy + Math.sin(angle) * r * 0.68;
      ctx.beginPath();
      ctx.strokeStyle = color(0.55);
      ctx.lineWidth = 1.5;
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
  }

  // Cardinal crosshair lines (dashed, extending outward)
  ctx.setLineDash([8, 12]);
  ctx.strokeStyle = color(0.28);
  ctx.lineWidth = 1;
  const ext = r * 1.65;
  [
    [cx - ext, cy, cx - r * 1.04, cy],
    [cx + r * 1.04, cy, cx + ext, cy],
    [cx, cy - ext, cx, cy - r * 1.04],
    [cx, cy + r * 1.04, cx, cy + ext],
  ].forEach(([x1, y1, x2, y2]) => {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  });
  ctx.setLineDash([]);

  // Cardinal brackets (T-marks at 0, 90, 180, 270 degrees)
  const bracketLen = r * 0.22;
  [
    [cx, cy - r, 0, -1],
    [cx + r, cy, 1, 0],
    [cx, cy + r, 0, 1],
    [cx - r, cy, -1, 0],
  ].forEach(([bx, by, nx, ny]) => {
    const px = ny;
    const py = -nx;
    ctx.save();
    ctx.strokeStyle = color(0.95);
    ctx.lineWidth = 2.8;
    ctx.shadowBlur = 10;
    ctx.shadowColor = color(0.8);
    ctx.beginPath();
    ctx.moveTo(bx + px * bracketLen, by + py * bracketLen);
    ctx.lineTo(bx, by);
    ctx.lineTo(bx - px * bracketLen, by - py * bracketLen);
    ctx.stroke();
    ctx.restore();
  });

  // Center dot
  ctx.save();
  ctx.shadowBlur = 14;
  ctx.shadowColor = color(1);
  ctx.fillStyle = color(0.9);
  ctx.beginPath();
  ctx.arc(cx, cy, appState.scanning ? 4 : 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // LOCK label above ring
  if (appState.outlinePoints?.length > 0 || appState.bbox) {
    const labelAlpha = 0.55 + Math.sin(now / 380) * 0.35;
    ctx.save();
    ctx.shadowBlur = 8;
    ctx.shadowColor = color(0.8);
    ctx.fillStyle = color(labelAlpha);
    ctx.font = `bold ${Math.round(11 * (window.devicePixelRatio || 1))}px monospace`;
    ctx.textAlign = "center";
    const label = isOverload ? "\u26a0 SCOUTER OVERLOAD" : (appState.scanning ? "ANALYZING..." : "TARGET LOCK");
    ctx.fillText(label, cx, cy - r - 14);
    ctx.textAlign = "left";
    ctx.restore();
  }

  ctx.restore();
}

function drawMeasurementAura(ctx, now, box) {
  if (!box) {
    return;
  }

  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const radiusX = box.w * 0.72;
  const radiusY = box.h * 0.64;
  const spin = (now / 420) % (Math.PI * 2);

  ctx.save();
  ctx.strokeStyle = appState.alert === "OVERLOAD" ? "rgba(255, 120, 120, 0.85)" : "rgba(72, 255, 146, 0.82)";
  ctx.lineWidth = 2.1;
  ctx.setLineDash([12, 10]);
  ctx.beginPath();
  ctx.ellipse(cx, cy, radiusX, radiusY, 0, spin, spin + Math.PI * 1.15);
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(cx, cy, radiusX * 0.82, radiusY * 0.82, 0, -spin, -spin + Math.PI * 1.1);
  ctx.stroke();
  ctx.setLineDash([]);

  const sweepY = box.y + (box.h * ((now / 6.5) % 1));
  const grad = ctx.createLinearGradient(box.x, sweepY - 12, box.x, sweepY + 12);
  grad.addColorStop(0, "rgba(72, 255, 146, 0)");
  grad.addColorStop(0.5, "rgba(72, 255, 146, 0.24)");
  grad.addColorStop(1, "rgba(72, 255, 146, 0)");
  ctx.fillStyle = grad;
  ctx.fillRect(box.x - box.w * 0.08, sweepY - 12, box.w * 1.16, 24);
  ctx.restore();
}

function drawTargetTelemetry(ctx, box) {
  if (!box) {
    return;
  }

  const labelX = clamp(box.x + box.w + 16, 16, overlay.width - 210);
  const labelY = clamp(box.y + 8, 24, overlay.height - 54);
  ctx.save();
  ctx.fillStyle = "rgba(226, 255, 235, 0.88)";
  ctx.font = `${13 * (window.devicePixelRatio || 1)}px monospace`;
  ctx.fillText(`LOCK : ${lockValue.textContent}`, labelX, labelY);
  ctx.fillText(`POWER: ${formatPower(appState.displayPower)}`, labelX, labelY + 20);
  ctx.fillText(`MODE : ${modeValue.textContent}`, labelX, labelY + 40);
  ctx.restore();
}

function drawHud(now) {
  const ctx = overlay.getContext("2d");
  const width = overlay.width;
  const height = overlay.height;
  ctx.clearRect(0, 0, width, height);

  drawFrameGuide(ctx, width, height);
  drawSweep(ctx, width, height, now);
  drawPersonOutline(ctx, now);

  const faceBox = normalizedBoxToCanvas(appState.bbox);
  const personBox = normalizedBoxToCanvas(appState.personBox);
  drawScouterReticle(ctx, now, faceBox || personBox);

  if (appState.scanning && personBox) {
    drawMeasurementAura(ctx, now, personBox);
  }

  drawTargetTelemetry(ctx, personBox || faceBox);
  hudAnimationId = window.requestAnimationFrame(drawHud);
}

function ensureAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === "suspended") {
    audioCtx.resume();
  }
}

function ensureSoundEffect2Loaded() {
  if (soundEffect2Buffer) return Promise.resolve(soundEffect2Buffer);
  if (soundEffect2BufferPromise) return soundEffect2BufferPromise;
  if (!audioCtx) ensureAudio();
  soundEffect2BufferPromise = fetch(SOUND_EFFECT_2_URL)
    .then((res) => {
      if (!res.ok) throw new Error(`failed to fetch ${SOUND_EFFECT_2_URL}: ${res.status}`);
      return res.arrayBuffer();
    })
    .then((arrayBuffer) => audioCtx.decodeAudioData(arrayBuffer))
    .then((buf) => {
      soundEffect2Buffer = buf;
      return buf;
    })
    .catch((err) => {
      soundEffect2BufferPromise = null;
      throw err;
    });
  return soundEffect2BufferPromise;
}

function stopSoundEffect2() {
  for (const src of soundEffect2Sources) {
    try { src.stop(); } catch (_) {}
  }
  soundEffect2Sources = [];
}

// Schedule the seamless 3-segment sequence:
//   ① 0s → 3s (3.0s)
//   ② 1s → 3s × 4 (8.0s)
//   ③ 1s → end (totalLen - 1)
// All segments are scheduled on audioCtx's clock so the boundaries are sample-accurate
// and the user never hears a gap between them.
function scheduleSoundEffect2Sequence() {
  if (!soundEffect2Buffer) return null;
  stopSoundEffect2();

  const buffer = soundEffect2Buffer;
  const total = buffer.duration;
  const introDur = Math.min(3, total);
  const loopOffset = Math.min(1, total);
  const loopDur = Math.max(0.05, Math.min(3, total) - loopOffset);
  const tailDur = Math.max(0.05, total - loopOffset);
  const lookahead = 0.06;
  const startTime = audioCtx.currentTime + lookahead;

  const sched = (offset, duration, atOffset) => {
    const src = audioCtx.createBufferSource();
    src.buffer = buffer;
    src.connect(audioCtx.destination);
    src.start(startTime + atOffset, offset, duration);
    soundEffect2Sources.push(src);
  };

  let cursor = 0;
  sched(0, introDur, cursor); cursor += introDur;
  for (let i = 0; i < 4; i++) {
    sched(loopOffset, loopDur, cursor);
    cursor += loopDur;
  }
  const tailStart = cursor;
  sched(loopOffset, tailDur, cursor);
  cursor += tailDur;

  return {
    startTime,
    bootMs: introDur * 1000,
    scanMs: loopDur * 4 * 1000,
    revealMs: tailDur * 1000,
    totalMs: cursor * 1000,
    bootEndAudioTime: startTime + introDur,
    scanEndAudioTime: startTime + tailStart,
    revealEndAudioTime: startTime + cursor,
  };
}

function setMode(text) {
  modeValue.textContent = text;
  stateChip.textContent = text;
}

function setMessage(text) {
  messageBox.textContent = text;
}

function setConnection(text, online = false) {
  connectionChip.textContent = text;
  connectionChip.style.color = online ? "#9dffb0" : "#ffb2b2";
}

function applyGeometry(result) {
  appState.bbox = result.bbox || null;
  appState.personBox = result.person_box || null;
  appState.outlinePoints = Array.isArray(result.outline_points) ? result.outline_points : [];
  appState.alert = result.alert || null;
  viewerFrame.classList.toggle("alert", result.alert === "OVERLOAD");
}

function applyTrackResult(result) {
  applyGeometry(result);
  lockValue.textContent = result.target_detected ? (result.face_detected ? "TARGET LOCK" : "BODY SIGNAL") : "SEARCHING";
  if (!appState.scanning) {
    setMode(result.target_detected ? "READY" : "IDLE");
    const canOverwriteReadout = appState.displayPower <= 0 || ["STANDBY", "TARGET READY", "NO TARGET"].includes(classValue.textContent);
    if (canOverwriteReadout) {
      classValue.textContent = result.target_detected ? "TARGET READY" : "STANDBY";
      if (!result.target_detected) {
        setMessage("人物をフレーム中央に入れてください。ロックすると輪郭を表示します。");
      } else {
        setMessage("人物センサー反応あり。計測開始で戦闘力スキャンを実行します。");
      }
    }
  }
}

function animatePowerTo(target, duration = 520) {
  if (powerAnimationId) {
    cancelAnimationFrame(powerAnimationId);
  }

  const startValue = appState.displayPower;
  const startTime = performance.now();

  function step(now) {
    const progress = clamp((now - startTime) / duration, 0, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    appState.displayPower = lerp(startValue, target, eased);
    powerValue.textContent = formatPower(appState.displayPower);

    if (progress < 1) {
      powerAnimationId = requestAnimationFrame(step);
    } else {
      appState.displayPower = target;
      powerValue.textContent = formatPower(target);
    }
  }

  powerAnimationId = requestAnimationFrame(step);
}

function startScrambleCounter(durationMs) {
  if (powerAnimationId) {
    cancelAnimationFrame(powerAnimationId);
  }

  const startTime = performance.now();
  appState.displayPower = 0;
  powerValue.textContent = "???";

  function step(now) {
    if (!appState.scanning) return;
    const elapsed = now - startTime;
    if (elapsed > durationMs) return;
    const progress = clamp(elapsed / durationMs, 0, 1);
    appState.scanProgress = progress;
    const candidate = appState.candidatePower || 1500;
    const scramble = Math.round(
      Math.random() * candidate * (progress * 1.6 + 0.25) +
      Math.random() * 2200
    );
    appState.displayPower = scramble;
    powerValue.textContent = formatPower(scramble);
    powerAnimationId = requestAnimationFrame(step);
  }

  powerAnimationId = requestAnimationFrame(step);
}

function startConvergeCounter(target, durationMs) {
  if (powerAnimationId) {
    cancelAnimationFrame(powerAnimationId);
  }

  const startTime = performance.now();
  const startValue = appState.displayPower || 0;

  function step(now) {
    const progress = clamp((now - startTime) / durationMs, 0, 1);
    if (progress < 0.55) {
      const noiseP = 1 - progress / 0.55;
      const noise = (Math.random() - 0.5) * Math.max(target, 800) * noiseP * 0.9;
      const drift = lerp(startValue, target, progress / 0.55 * 0.6);
      const v = Math.max(0, Math.round(drift + noise));
      appState.displayPower = v;
      powerValue.textContent = formatPower(v);
    } else {
      const eased = 1 - Math.pow(1 - (progress - 0.55) / 0.45, 3);
      const base = lerp(startValue, target, 0.6);
      const v = lerp(base, target, eased);
      appState.displayPower = v;
      powerValue.textContent = formatPower(Math.round(v));
    }

    if (progress < 1) {
      powerAnimationId = requestAnimationFrame(step);
    } else {
      appState.displayPower = target;
      powerValue.textContent = formatPower(target);
    }
  }

  powerAnimationId = requestAnimationFrame(step);
}

function spawnRisingNumber(value, isFinal = false) {
  if (!risingColumn) return;
  const div = document.createElement("div");
  div.className = isFinal ? "rising-number final" : "rising-number";
  div.textContent = formatPower(value);
  risingColumn.appendChild(div);
  const lifetime = isFinal ? 4200 : 1700;
  window.setTimeout(() => { try { div.remove(); } catch (_) {} }, lifetime);
}

function startRisingNumbersSpawner() {
  if (!risingColumn) return;
  stopRisingNumbersSpawner();
  risingColumn.classList.add("active");
  const tick = () => {
    const candidate = appState.candidatePower || 1500;
    const intensity = 0.6 + appState.scanProgress * 1.8;
    const value = Math.round(
      Math.random() * candidate * intensity +
      Math.random() * 800
    );
    spawnRisingNumber(value, false);
  };
  tick();
  risingNumberInterval = window.setInterval(tick, 110);
}

function stopRisingNumbersSpawner() {
  if (risingNumberInterval) {
    clearInterval(risingNumberInterval);
    risingNumberInterval = null;
  }
}

function showLockFlash() {
  viewerFrame.classList.remove("lock-flash");
  // restart the CSS animation
  void viewerFrame.offsetWidth;
  viewerFrame.classList.add("lock-flash");
  window.setTimeout(() => viewerFrame.classList.remove("lock-flash"), 700);
}

async function waitUntilAudioTime(targetAudioTime) {
  if (!audioCtx) return;
  while (audioCtx.currentTime < targetAudioTime) {
    const remainingMs = (targetAudioTime - audioCtx.currentTime) * 1000;
    await wait(clamp(remainingMs, 16, 120));
  }
}

function stopCurrentStream() {
  const stream = video.srcObject;
  if (stream?.getTracks) {
    stream.getTracks().forEach((track) => track.stop());
  }
  video.srcObject = null;
  appState.streamReady = false;
  scanBtn.disabled = true;
  stopTrackingLoop();
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setMessage("このブラウザはカメラ API に対応していません。");
    setConnection("CAMERA UNSUPPORTED", false);
    setMode("ERROR");
    return;
  }

  if (!window.isSecureContext) {
    setMessage("このページは安全なコンテキストではありません。HTTPS と信頼済み証明書で開いてください。");
    setConnection("SECURE CONTEXT REQUIRED", false);
    setMode("ERROR");
    return;
  }

  stopCurrentStream();

  try {
    ensureAudio();
    ensureSoundEffect2Loaded().catch((err) => console.error("Sound_effect_2 preload failed:", err));
    const deviceId = cameraSelect.value;
    const videoConstraints = {
      width: { ideal: 1280 },
      height: { ideal: 720 },
    };
    if (deviceId) {
      videoConstraints.deviceId = { exact: deviceId };
    } else {
      videoConstraints.facingMode = "user";
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      video: videoConstraints,
      audio: false,
    });

    video.srcObject = stream;
    await video.play();
    const activeId = stream.getVideoTracks()[0]?.getSettings().deviceId || "";
    await populateCameraList(activeId);
    appState.streamReady = true;
    startBtn.textContent = "カメラ再接続";
    scanBtn.disabled = false;
    setConnection("CAMERA ONLINE", true);
    setMode("READY");
    classValue.textContent = "STANDBY";
    lockValue.textContent = "SEARCHING";
    setMessage("人物をフレーム中央に入れてください。ロック後に計測開始できます。");
    resizeOverlay();
    startTrackingLoop();
  } catch (error) {
    console.error(error);
    setConnection("CAMERA ERROR", false);
    setMode("ERROR");
    setMessage(describeCameraError(error));
  }
}

function describeCameraError(error) {
  switch (error?.name) {
    case "NotAllowedError":
      return "カメラ権限が拒否されました。ブラウザ権限と証明書の信頼設定を確認してください。";
    case "NotFoundError":
      return "利用可能なカメラが見つかりませんでした。";
    case "NotReadableError":
      return "カメラが他のアプリで使用中の可能性があります。";
    case "OverconstrainedError":
      return "要求したカメラ条件を満たせませんでした。";
    default:
      return "カメラへアクセスできませんでした。HTTPS とブラウザ権限を確認してください。";
  }
}

function captureCurrentFrame() {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) {
    throw new Error("Video is not ready");
  }

  const scale = Math.min(1, CAPTURE_MAX_WIDTH / width);
  const targetWidth = Math.max(320, Math.round(width * scale));
  const targetHeight = Math.max(180, Math.round(height * scale));

  captureCanvas.width = targetWidth;
  captureCanvas.height = targetHeight;
  const ctx = captureCanvas.getContext("2d", { willReadFrequently: false });
  ctx.drawImage(video, 0, 0, targetWidth, targetHeight);
  return captureCanvas.toDataURL("image/jpeg", 0.9);
}

async function postFrame(endpoint) {
  const image = captureCurrentFrame();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image, client_id: appState.clientId }),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) {
    throw new Error(result.error || "request failed");
  }
  return result;
}

function startTrackingLoop() {
  stopTrackingLoop();

  const tick = async () => {
    if (!appState.streamReady || appState.scanning || document.hidden || trackingBusy) {
      return;
    }

    trackingBusy = true;
    try {
      const result = await postFrame("/track");
      applyTrackResult(result);
    } catch (error) {
      console.error(error);
    } finally {
      trackingBusy = false;
    }
  };

  tick();
  trackTimerId = window.setInterval(tick, 900);
}

function stopTrackingLoop() {
  if (trackTimerId) {
    clearInterval(trackTimerId);
    trackTimerId = null;
  }
}

function scoreResult(result) {
  if (!result?.target_detected) {
    return -1;
  }

  const metrics = result.metrics || {};
  return (
    (result.power_level || 0) +
    (metrics.centeredness || 0) * 600 +
    (metrics.signal_strength || 0) * 40 +
    (result.face_detected ? 300 : 0)
  );
}

async function runScanAnalysisUntil(deadlineAudioTime, intervalMs = 420) {
  let bestResult = null;
  while (audioCtx && audioCtx.currentTime < deadlineAudioTime) {
    const sampleStartedAt = performance.now();
    try {
      const result = await postFrame("/analyze");
      applyGeometry(result);
      lockValue.textContent = result.target_detected
        ? (result.face_detected ? "TARGET LOCK" : "BODY SIGNAL")
        : "SEARCHING";
      classValue.textContent = result.class_name || "SCANNING";
      setMessage(result.target_detected
        ? "対象スキャン中... 戦闘力を解析しています。"
        : "対象探索中... フレーム中央を維持してください。");
      appState.candidatePower = Math.max(appState.candidatePower, result.power_level || 0);
      if (!bestResult || scoreResult(result) > scoreResult(bestResult)) {
        bestResult = result;
      }
    } catch (error) {
      console.error(error);
    }

    const remainingMs = (deadlineAudioTime - audioCtx.currentTime) * 1000;
    if (remainingMs <= 0) break;
    const spent = performance.now() - sampleStartedAt;
    const waitMs = Math.min(intervalMs - spent, remainingMs - 30);
    if (waitMs > 0) await wait(waitMs);
  }
  return bestResult;
}

async function startMeasurement() {
  if (!appState.streamReady) {
    setMessage("先にカメラ接続を実行してください。");
    return;
  }
  if (appState.scanning) {
    return;
  }

  ensureAudio();
  try {
    await ensureSoundEffect2Loaded();
  } catch (error) {
    console.error("Sound_effect_2 load failed:", error);
  }

  stopTrackingLoop();
  appState.scanning = true;
  appState.booting = true;
  appState.candidatePower = 0;
  appState.scanProgress = 0;
  appState.alert = null;
  viewerFrame.classList.add("booting");
  viewerFrame.classList.remove("alert");
  viewerFrame.classList.remove("lock-flash");
  startBtn.disabled = true;
  scanBtn.disabled = true;
  lockValue.textContent = appState.outlinePoints.length ? "TARGET LOCK" : "SEARCHING";
  classValue.textContent = "SCOUTER BOOT";
  setMode("BOOT");
  setMessage("スカウター起動中... センサーを初期化しています。");

  const seq = scheduleSoundEffect2Sequence();
  const fallbackBootMs = 3000;
  const fallbackScanMs = 8000;
  const fallbackRevealMs = 3075;
  const bootMs = seq?.bootMs ?? fallbackBootMs;
  const scanMs = seq?.scanMs ?? fallbackScanMs;
  const revealMs = seq?.revealMs ?? fallbackRevealMs;

  startRisingNumbersSpawner();
  appState.displayPower = 0;
  powerValue.textContent = "???";

  // ① ブート位相（segment 0-3s 中）
  if (seq) {
    await waitUntilAudioTime(seq.bootEndAudioTime);
  } else {
    await wait(bootMs);
  }

  if (!appState.scanning) return;

  appState.booting = false;
  viewerFrame.classList.remove("booting");
  viewerFrame.classList.add("scanning");
  classValue.textContent = "SCANNING";
  setMode("SCANNING");
  setMessage("対象スキャン中... 戦闘力を計測しています。");

  // 中央のメインカウンタは scan + reveal フェーズ全域でまずスクランブル
  startScrambleCounter(scanMs + revealMs);

  // ② スキャン位相（segment 1-3s ×4 中：解析API呼び出し）
  let result = null;
  if (seq) {
    result = await runScanAnalysisUntil(seq.scanEndAudioTime, 420);
  } else {
    // フォールバック：時間ベース
    const startedAt = performance.now();
    while (performance.now() - startedAt < scanMs) {
      try {
        const r = await postFrame("/analyze");
        applyGeometry(r);
        appState.candidatePower = Math.max(appState.candidatePower, r.power_level || 0);
        if (!result || scoreResult(r) > scoreResult(result)) result = r;
      } catch (e) { console.error(e); }
      await wait(420);
    }
  }

  if (!appState.scanning) return;

  // ③ リビール位相（segment 1-end 中：最終値へ収束）
  const finalPower = result?.power_level || 0;
  classValue.textContent = result?.class_name || "ANALYZING";
  setMessage("戦闘力解析中... 値を確定しています。");
  startConvergeCounter(finalPower, Math.max(400, revealMs - 120));

  // 最後の音の直前で戦闘力確定
  if (seq) {
    await waitUntilAudioTime(seq.revealEndAudioTime - 0.08);
  } else {
    await wait(Math.max(0, revealMs - 80));
  }

  // 戦闘力確定（mp3末尾とシンクロ）
  stopRisingNumbersSpawner();
  if (powerAnimationId) cancelAnimationFrame(powerAnimationId);
  appState.displayPower = finalPower;
  powerValue.textContent = formatPower(finalPower);
  spawnRisingNumber(finalPower, true);
  showLockFlash();

  appState.scanning = false;
  viewerFrame.classList.remove("scanning");
  startBtn.disabled = false;
  scanBtn.disabled = false;

  if (!result?.target_detected) {
    appState.alert = null;
    appState.bbox = null;
    appState.personBox = null;
    appState.outlinePoints = [];
    classValue.textContent = "NO TARGET";
    lockValue.textContent = "SEARCHING";
    setMode("NO TARGET");
    setMessage("人物を検出できませんでした。フレーム中央で再計測してください。");
    animatePowerTo(0, 380);
    startTrackingLoop();
    return;
  }

  applyGeometry(result);
  classValue.textContent = result.class_name;
  lockValue.textContent = result.face_detected ? "TARGET LOCK" : "BODY SIGNAL";
  setMode(result.alert === "OVERLOAD" ? "OVERLOAD" : "LOCKED");
  setMessage(result.message || "スキャン完了。");
  if (finalPower >= 9000) {
    viewerFrame.classList.add("shaking");
    setTimeout(() => viewerFrame.classList.remove("shaking"), 600);
  }
  startTrackingLoop();
}

startBtn.addEventListener("click", async () => {
  await startCamera();
});

scanBtn.addEventListener("click", async () => {
  await startMeasurement();
});

cameraSelect.addEventListener("change", async () => {
  if (appState.streamReady) {
    await startCamera();
  }
});

window.addEventListener("resize", resizeOverlay);
video.addEventListener("loadedmetadata", resizeOverlay);
window.addEventListener("load", () => {
  resizeOverlay();
  if (!hudAnimationId) {
    drawHud(performance.now());
  }
});
