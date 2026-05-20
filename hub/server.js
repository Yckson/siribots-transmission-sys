const dgram = require("dgram");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const express = require("express");
const WebSocket = require("ws");
require("dotenv").config();

const DISCOVER_SOURCE = "DISCOVER_HUB_SOURCE";
const DISCOVER_VIEWER = "DISCOVER_HUB_CLIENT";

const UDP_PORT_SOURCE = 41001;
const UDP_PORT_VIEWER = 41002;
const WS_PORT = 42000;
const UI_WS_PORT = Number.parseInt(process.env.UI_WS_PORT || "42001", 10);
const HTTP_PORT = Number.parseInt(process.env.HLS_HTTP_PORT || "43000", 10);
const WAITING_INTERVAL_MS = 1000;
const WAITING_TIMEOUT_MS = 5000;
const MAX_INPUT_BUFFER_BYTES = Number.parseInt(process.env.MAX_INPUT_BUFFER_BYTES || "2097152", 10);
const HLS_DIR = path.join(__dirname, "hls");
const ASSETS_DIR = path.join(__dirname, "assets");
const PUBLIC_DIR = path.join(__dirname, "public");
const CONFIG_PATH = path.join(__dirname, "hub-config.json");
const HLS_PLAYLIST = "stream.m3u8";
const HLS_SEGMENT_PATTERN = "segment_%03d.ts";
const WAITING_SEGMENT = "waiting.ts";
const HLS_INPUT_FORMAT = (process.env.HLS_INPUT_FORMAT || "mpegts").trim();
const HLS_LIST_SIZE = Number.parseInt(process.env.HLS_LIST_SIZE || "6", 10);
const HLS_TIME_SECONDS = Number.parseFloat(process.env.HLS_TIME_SECONDS || "1");
const HLS_FPS = Number.parseInt(process.env.HLS_FPS || "30", 10);
const HLS_GOP = Math.max(1, Math.round(HLS_FPS * HLS_TIME_SECONDS));
const HLS_WAITING_SIZE = (process.env.HLS_WAITING_SIZE || "640x480").trim();
const HLS_WAITING_FPS = Number.parseInt(process.env.HLS_WAITING_FPS || "30", 10);

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    return {
      schedule: [],
      meta: { title: "Transmissao do Robo", description: "Sinal direto da base Siribots" },
      overlay: { enabled: false, filename: null, updatedAt: null },
    };
  }

  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return {
      schedule: Array.isArray(parsed.schedule) ? parsed.schedule : [],
      meta: {
        title: parsed.meta?.title || "Transmissao do Robo",
        description: parsed.meta?.description || "Sinal direto da base Siribots",
      },
      overlay: {
        enabled: Boolean(parsed.overlay?.enabled),
        filename: parsed.overlay?.filename || null,
        updatedAt: parsed.overlay?.updatedAt || null,
      },
    };
  } catch (error) {
    console.warn("Failed to load config, using defaults:", error.message);
    return {
      schedule: [],
      meta: { title: "Transmissao do Robo", description: "Sinal direto da base Siribots" },
      overlay: { enabled: false, filename: null, updatedAt: null },
    };
  }
}

function saveConfig(config) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  } catch (error) {
    console.warn("Failed to save config:", error.message);
  }
}

function ensureAssetsDir() {
  fs.mkdirSync(ASSETS_DIR, { recursive: true });
}

function getIpFacingClient(clientIp) {
  const interfaces = os.networkInterfaces();
  const ipToInt = (ip) => ip.split('.').reduce((int, oct) => (int << 8) + parseInt(oct, 10), 0) >>> 0;
  
  const clientInt = ipToInt(clientIp);

  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name]) {
      if (net.family === "IPv4" && !net.internal) {
        const netInt = ipToInt(net.address);
        const maskInt = ipToInt(net.netmask);
        if ((clientInt & maskInt) === (netInt & maskInt)) {
          return net.address;
        }
      }
    }
  }

  console.warn(`Nenhuma interface de rede no Hub compartilha a subnet com ${clientIp}. Caindo para 127.0.0.1`);
  return "127.0.0.1";
}

function createUdpListener(port, role) {
  const socket = dgram.createSocket("udp4");

  socket.on("message", (msg, rinfo) => {
    const text = msg.toString("utf8").trim();
    const expected = role === "source" ? DISCOVER_SOURCE : DISCOVER_VIEWER;

    if (text !== expected) {
      return;
    }

    const bestHubIp = getIpFacingClient(rinfo.address);

    const response = JSON.stringify({
      hubIp: bestHubIp,
      wsPort: WS_PORT,
      hlsPort: HTTP_PORT,
      hlsPath: `/${HLS_PLAYLIST}`,
      role,
    });

    socket.send(response, rinfo.port, rinfo.address);
    const now = new Date().toISOString();
    console.log(`[${now}] ${role} discovery from ${rinfo.address}:${rinfo.port}. Respondendo com IP do Hub: ${bestHubIp}`);
  });

  socket.bind(port, () => {
    console.log(`UDP ${role} listener on 0.0.0.0:${port}`);
  });

  return socket;
}

const sourceListener = createUdpListener(UDP_PORT_SOURCE, "source");
// Mantemos o listener UDP Viewer caso o app mobile ainda o utilize para achar o IP do painel via rede.
const viewerListener = createUdpListener(UDP_PORT_VIEWER, "viewer");

function ensureHlsDir() {
  fs.mkdirSync(HLS_DIR, { recursive: true });
}

function clearHlsDir() {
  ensureHlsDir();
  for (const entry of fs.readdirSync(HLS_DIR)) {
    if ((entry.endsWith(".ts") || entry.endsWith(".m3u8")) && entry !== WAITING_SEGMENT) {
      try {
        fs.unlinkSync(path.join(HLS_DIR, entry));
      } catch (error) {
        console.warn("Failed to delete", entry, error.message);
      }
    }
  }
}

const app = express();
app.use(express.json({ limit: "5mb" }));

let appConfig = loadConfig();

// --- MIDDLEWARES ---
// Middleware de Segurança: Bloqueia acesso à rota de admin para IPs externos
function adminOnly(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  // Express lida com IPv4 mapeado em IPv6 (::ffff:127.0.0.1) ou localhost puro
  if (ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1") {
    next();
  } else {
    console.log(`Tentativa de acesso bloqueada ao /admin vinda de ${ip}`);
    res.status(403).send("<h1>403 Proibido</h1><p>A área de administração só pode ser acessada pelo computador local (Hub).</p>");
  }
}

// --- ROTAS WEB HTML ---

function sendPublicFile(res, filename) {
  res.sendFile(path.join(PUBLIC_DIR, filename));
}

// Rota 1: Página do Viewer (Pública)
app.get("/", (req, res) => {
  sendPublicFile(res, "viewer.html");
});

// Rota 2: Página de Admin (Restrita ao Localhost)
app.get("/admin", adminOnly, (req, res) => {
  sendPublicFile(res, "admin.html");
});

// --- FIM ROTAS WEB ---

function buildWaitingPlaylist() {
  const targetDuration = Math.max(1, Math.ceil(HLS_TIME_SECONDS));
  const seq = Math.floor(Date.now() / 1000 / targetDuration) % 1000;

  return [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-ALLOW-CACHE:NO",
    `#EXT-X-TARGETDURATION:${targetDuration}`,
    `#EXT-X-MEDIA-SEQUENCE:${seq}`,
    `#EXTINF:${targetDuration.toFixed(3)},`,
    WAITING_SEGMENT,
  ].join("\n");
}

function ensureWaitingSegment() {
  const segmentPath = path.join(HLS_DIR, WAITING_SEGMENT);
  if (fs.existsSync(segmentPath)) {
    return;
  }

  ensureHlsDir();
  const args = [
    "-hide_banner",
    "-loglevel", "warning",
    "-f", "lavfi",
    "-i", `color=c=black:s=${HLS_WAITING_SIZE}:r=${HLS_WAITING_FPS}`,
    "-t", "1",
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-tune", "zerolatency",
    "-pix_fmt", "yuv420p",
    "-f", "mpegts",
    segmentPath,
  ];

  const child = spawn(process.env.FFMPEG_PATH || "ffmpeg", args, {
    stdio: ["ignore", "ignore", "pipe"],
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8").trim();
    if (text) {
      console.log(`[FFmpeg] waiting segment: ${text}`);
    }
  });
}

function getStreamStatus() {
  const now = Date.now();
  const sourceStale = now - lastSourceFrameAt > WAITING_TIMEOUT_MS;
  return Boolean(activeSource) && !sourceStale ? "live" : "waiting";
}

app.get("/status", (req, res) => {
  const payload = { status: getStreamStatus() };
  res.json(payload);
});

app.get("/ui-config", (req, res) => {
  res.json({ uiWsPort: UI_WS_PORT });
});

app.post("/admin/api/schedule", adminOnly, (req, res) => {
  const schedule = Array.isArray(req.body?.schedule) ? req.body.schedule : [];
  const meta = req.body?.meta || {};
  appConfig = {
    ...appConfig,
    schedule: schedule.map((item) => ({
      time: String(item.time || "").trim(),
      title: String(item.title || "").trim(),
    })),
    meta: {
      title: String(meta.title || appConfig.meta?.title || "").trim(),
      description: String(meta.description || appConfig.meta?.description || "").trim(),
    },
  };
  saveConfig(appConfig);
  broadcastState();
  res.json({ ok: true });
});

app.post("/admin/api/overlay", adminOnly, (req, res) => {
  const dataUrl = req.body?.dataUrl;
  const enabled = Boolean(req.body?.enabled);
  let filename = appConfig.overlay.filename || null;

  if (typeof dataUrl === "string" && dataUrl.startsWith("data:image/")) {
    const matches = dataUrl.match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/);
    if (!matches) {
      res.status(400).json({ ok: false, error: "Invalid image data" });
      return;
    }
    const ext = matches[1] === "jpeg" ? "jpg" : matches[1];
    const buffer = Buffer.from(matches[2], "base64");
    ensureAssetsDir();
    filename = `overlay.${ext}`;
    fs.writeFileSync(path.join(ASSETS_DIR, filename), buffer);
  }

  appConfig = {
    ...appConfig,
    overlay: {
      enabled,
      filename,
      updatedAt: new Date().toISOString(),
    },
  };
  saveConfig(appConfig);
  broadcastState();
  res.json({ ok: true });
});

app.get(`/${HLS_PLAYLIST}`, (req, res) => {
  const playlistPath = path.join(HLS_DIR, HLS_PLAYLIST);
  if (fs.existsSync(playlistPath)) {
    let content = "";
    try {
      content = fs.readFileSync(playlistPath, "utf8");
    } catch (error) {
      console.warn("Failed to read playlist, serving waiting.", error.message);
    }

    if (content && !content.includes("#EXT-X-TARGETDURATION:0") && content.includes("#EXTINF:")) {
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
      res.send(content);
      return;
    }
  }

  ensureWaitingSegment();
  res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.send(buildWaitingPlaylist());
});

// Middleware para servir os arquivos HLS (.ts e .m3u8).
// É carregado após as rotas HTML para não dar conflito com o '/'
app.use(
  "/",
  express.static(HLS_DIR, {
    setHeaders(res, filePath) {
      if (filePath.endsWith(".m3u8")) {
        res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      } else if (filePath.endsWith(".ts")) {
        res.setHeader("Content-Type", "video/MP2T");
      }
    },
  })
);

app.use("/assets", express.static(ASSETS_DIR));

const httpServer = app.listen(HTTP_PORT, "0.0.0.0", () => {
  console.log(`Servidor Web/HLS iniciado na porta :${HTTP_PORT}`);
  console.log(`-> Painel do Robô: http://localhost:${HTTP_PORT}`);
  console.log(`-> Admin (Restrito): http://127.0.0.1:${HTTP_PORT}/admin`);
});

const wss = new WebSocket.Server({ port: WS_PORT }, () => {
  console.log(`WebSocket server apenas para Fonte iniciado na porta :${WS_PORT}`);
});

const uiWss = new WebSocket.Server({ port: UI_WS_PORT }, () => {
  console.log(`WebSocket server UI iniciado na porta :${UI_WS_PORT}`);
});

let activeSource = null;
let lastSourceFrameAt = 0;
let ffmpegProcess = null;
let lastBroadcastStatus = "unknown";

function buildStatePayload() {
  return {
    type: "state",
    status: getStreamStatus(),
    config: appConfig,
  };
}

function broadcastState() {
  const payload = JSON.stringify(buildStatePayload());
  for (const client of uiWss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

function buildFfmpegArgs() {
  const playlistPath = path.join(HLS_DIR, HLS_PLAYLIST);
  const segmentPath = path.join(HLS_DIR, HLS_SEGMENT_PATTERN);

  return [
    "-hide_banner",
    "-loglevel", "warning",
    "-fflags", "nobuffer+genpts",
    "-flags", "low_delay",
    "-use_wallclock_as_timestamps", "1",
    "-analyzeduration", "1000000", 
    "-probesize", "1000000",
    "-f", "mjpeg", 
    "-i", "pipe:0",
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-tune", "zerolatency",
    "-profile:v", "baseline",
    "-pix_fmt", "yuv420p",
    "-g", `${HLS_GOP}`,
    "-keyint_min", `${HLS_GOP}`,
    "-sc_threshold", "0",
    "-an",
    "-hls_time", `${HLS_TIME_SECONDS}`,
    "-hls_list_size", `${HLS_LIST_SIZE}`,
    "-hls_flags", "delete_segments+temp_file",
    "-hls_segment_filename", segmentPath,
    playlistPath,
  ];
}

function startFfmpeg() {
  if (ffmpegProcess) return;

  clearHlsDir();
  const args = buildFfmpegArgs();

  ffmpegProcess = spawn(process.env.FFMPEG_PATH || "ffmpeg", args, {
    stdio: ["pipe", "ignore", "pipe"],
  });

  ffmpegProcess.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8").trim();
    if (text) console.log(`[FFmpeg] ${text}`);
  });

  ffmpegProcess.on("close", (code, signal) => {
    console.log(`FFmpeg exited with code ${code}, signal ${signal || "none"}`);
    ffmpegProcess = null;
  });

  ffmpegProcess.on("error", (error) => {
    console.error("Failed to start FFmpeg:", error.message);
    ffmpegProcess = null;
  });
}

function stopFfmpeg() {
  if (!ffmpegProcess) return;
  ffmpegProcess.stdin.end();
  ffmpegProcess.kill("SIGINT");
  ffmpegProcess = null;
}

setInterval(() => {
  const now = Date.now();
  const sourceStale = now - lastSourceFrameAt > WAITING_TIMEOUT_MS;
  if (!activeSource || sourceStale) {
    stopFfmpeg();
  }

  const currentStatus = getStreamStatus();
  if (currentStatus !== lastBroadcastStatus) {
    lastBroadcastStatus = currentStatus;
    broadcastState();
  }
}, WAITING_INTERVAL_MS);

uiWss.on("connection", (ws, req) => {
  const remote = req.socket.remoteAddress || "unknown";
  console.log(`[${new Date().toISOString()}] UI conectado de ${remote}`);
  ws.send(JSON.stringify(buildStatePayload()));

  ws.on("close", () => {
    console.log(`[${new Date().toISOString()}] UI desconectado de ${remote}`);
  });
});

wss.on("connection", (ws, req) => {
  const remote = req.socket.remoteAddress || "unknown";
  console.log(`[${new Date().toISOString()}] Nova tentativa de conexão WS vinda de ${remote}`);

  ws.on("message", (data, isBinary) => {
    // Se for texto (handshake)
    if (!isBinary) {
      let payload;
      try {
        payload = JSON.parse(data.toString("utf8"));
      } catch (error) {
        ws.close(1008, "Invalid handshake");
        return;
      }

      if (payload?.role === "source") {
        if (activeSource && activeSource !== ws) {
          activeSource.close(1012, "Replaced by new source");
        }
        activeSource = ws;
        lastSourceFrameAt = Date.now();
        console.log(`[${new Date().toISOString()}] ✅ Placa FONTE (Odroid) autorizada a transmitir a partir de ${remote}`);
        return;
      }

      // Rejeita qualquer viewer pelo WebSocket
      if (payload?.role === "viewer") {
        console.warn(`[${new Date().toISOString()}] ❌ Conexão WebSocket Viewer rejeitada. O visualizador usa apenas HTTP agora.`);
        ws.close(1008, "Viewer websockets unsupported. Please use HTTP Web Viewer.");
        return;
      }

      ws.close(1008, "Unknown role");
      return;
    }

    // Se for binário, é o vídeo chegando da Odroid
    if (ws === activeSource && isBinary) {
      lastSourceFrameAt = Date.now();
      startFfmpeg();
      if (ffmpegProcess?.stdin?.writable) {
        if (ffmpegProcess.stdin.writableLength > MAX_INPUT_BUFFER_BYTES) {
          return; // Prevenção de gargalo
        }
        ffmpegProcess.stdin.write(data);
      }
    }
  });

  ws.on("close", () => {
    if (activeSource === ws) {
      activeSource = null;
      stopFfmpeg();
      console.log(`[${new Date().toISOString()}] 🔌 Fonte desconectada de ${remote}`);
    }
  });
});

process.on("SIGINT", () => {
  sourceListener.close();
  viewerListener.close();
  wss.close();
  uiWss.close();
  httpServer.close();
  stopFfmpeg();
  process.exit(0);
});