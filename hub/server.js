const dgram = require("dgram");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const express = require("express");
const WebSocket = require("ws");
const crypto = require("crypto");
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
// Novo estado para a corrida
let raceState = {
  time: "00.000",
  showOverlay: false
};

// --- CREDENCIAIS E SESSÃO ---
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "admin";
// Token gerado aleatoriamente ao iniciar o servidor. Invalida sessões antigas ao reiniciar.
const SESSION_TOKEN = crypto.randomBytes(32).toString('hex');

// --- MIDDLEWARES ---
// Middleware de Segurança: Protege a rota através do cookie de sessão
function adminOnly(req, res, next) {
  const cookieHeader = req.headers.cookie || "";
  if (cookieHeader.includes(`admin_session=${SESSION_TOKEN}`)) {
    next();
  } else {
    // Se for uma requisição direta pelo navegador (GET), redireciona para o login
    if (req.method === "GET") {
      res.redirect("/login");
    } else {
      res.status(401).json({ ok: false, error: "Não autorizado. Inicie sessão novamente." });
    }
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

app.get("/generate", (req, res) => {
  sendPublicFile(res, "generator.html");
});

// Rota da Página de Login
app.get("/login", (req, res) => {
  sendPublicFile(res, "login.html");
});

app.use('/libs', express.static(path.join(__dirname, 'libs')));

// Rota 2: Página de Admin (Agora protegida por login na rede)
app.get("/admin", adminOnly, (req, res) => {
  sendPublicFile(res, "admin.html");
});

// --- ROTAS DE AUTENTICAÇÃO ---
app.post("/api/login", (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    // Cria o cookie que dura 24 horas
    res.cookie("admin_session", SESSION_TOKEN, { httpOnly: true, maxAge: 24 * 60 * 60 * 1000 });
    res.json({ ok: true });
  } else {
    res.status(401).json({ ok: false, error: "Utilizador ou palavra-passe incorretos" });
  }
});

app.post("/api/logout", (req, res) => {
  res.clearCookie("admin_session");
  res.json({ ok: true });
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
  // O status "ao vivo" depende agora APENAS da placa de vídeo
  return Boolean(activeVideoSource) && !sourceStale ? "live" : "waiting";
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

// --- ROTAS DA CORRIDA ---
app.post("/admin/api/race/start", adminOnly, (req, res) => {
  // Agora validamos a source de telemetria
  if (activeTelemetrySource && activeTelemetrySource.readyState === WebSocket.OPEN) {
    // Envia o comando para a Odroid
    activeTelemetrySource.send(JSON.stringify({ cmd: "START_RACE" }));
    
    // Zera o tempo no painel e no visualizador imediatamente
    raceState.time = "00.000";
    broadcastState();
    
    res.json({ ok: true, message: "Comando enviado ao Arduino" });
  } else {
    res.status(400).json({ ok: false, error: "A placa Odroid (Telemetria) não está ligada" });
  }
});

app.post("/admin/api/race/overlay", adminOnly, (req, res) => {
  raceState.showOverlay = Boolean(req.body.enabled);
  broadcastState();
  res.json({ ok: true });
});
// --- FIM ROTAS DA CORRIDA ---

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
  console.log(`-> Admin (Protegido por Login): http://localhost:${HTTP_PORT}/admin`);
});

const wss = new WebSocket.Server({ port: WS_PORT }, () => {
  console.log(`WebSocket server apenas para Fontes iniciado na porta :${WS_PORT}`);
});

const uiWss = new WebSocket.Server({ port: UI_WS_PORT }, () => {
  console.log(`WebSocket server UI iniciado na porta :${UI_WS_PORT}`);
});

// AS DUAS VARIÁVEIS SEPARADAS AQUI:
let activeVideoSource = null;
let activeTelemetrySource = null;

let lastSourceFrameAt = 0;
let ffmpegProcess = null;
let lastBroadcastStatus = "unknown";

function buildStatePayload() {
  return {
    type: "state",
    status: getStreamStatus(),
    config: appConfig,
    race: raceState,
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
  // Apenas a fonte de VÍDEO afeta o FFmpeg
  if (!activeVideoSource || sourceStale) {
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
    // Se for texto (handshake ou dados da telemetria)
    if (!isBinary) {
      let payload;
      try {
        payload = JSON.parse(data.toString("utf8"));
      } catch (error) {
        ws.close(1008, "Invalid handshake");
        return;
      }

      if (payload?.role === "source") {
        const isTelemetry = payload.type === "telemetry";

        if (isTelemetry) {
          // Acomoda na cadeira de Telemetria
          if (activeTelemetrySource && activeTelemetrySource !== ws) {
            activeTelemetrySource.close(1012, "Replaced by new telemetry source");
          }
          activeTelemetrySource = ws;
          console.log(`[${new Date().toISOString()}] 🏎️ Placa TELEMETRIA (Odroid/Arduino) autorizada a partir de ${remote}`);
        } else {
          // Acomoda na cadeira de Vídeo
          if (activeVideoSource && activeVideoSource !== ws) {
            activeVideoSource.close(1012, "Replaced by new video source");
          }
          activeVideoSource = ws;
          lastSourceFrameAt = Date.now();
          console.log(`[${new Date().toISOString()}] 🎥 Placa VÍDEO autorizada a transmitir a partir de ${remote}`);
        }
        return;
      }

      if (payload?.event === "arduino_data") {
         const linha = payload.payload;
         // Se o Arduino enviou "T:15.340"
         if (linha.startsWith("T:")) {
             raceState.time = linha.substring(2);
             console.log(`[CORRIDA] Tempo final recebido: ${raceState.time}s`);
             broadcastState(); // Atualiza a UI imediatamente
         }
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

    // Se for binário, verificamos estritamente a fonte de vídeo
    if (ws === activeVideoSource && isBinary) {
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
    // Verifica qual das placas se desligou
    if (activeVideoSource === ws) {
      activeVideoSource = null;
      stopFfmpeg();
      console.log(`[${new Date().toISOString()}] 🔌 Fonte de VÍDEO desconectada de ${remote}`);
    }
    if (activeTelemetrySource === ws) {
      activeTelemetrySource = null;
      console.log(`[${new Date().toISOString()}] 🔌 Fonte de TELEMETRIA (Arduino) desconectada de ${remote}`);
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