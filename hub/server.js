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
const HTTP_PORT = Number.parseInt(process.env.HLS_HTTP_PORT || "43000", 10);
const WAITING_INTERVAL_MS = 1000;
const WAITING_TIMEOUT_MS = 5000;
const MAX_INPUT_BUFFER_BYTES = Number.parseInt(process.env.MAX_INPUT_BUFFER_BYTES || "2097152", 10);
const HLS_DIR = path.join(__dirname, "hls");
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

// Rota 1: Página do Viewer (Pública)
app.get("/", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Siribots - Visualizador Ao Vivo</title>
      <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
      <style>
        body { margin: 0; padding: 0; background-color: #000; display: flex; flex-direction: column; height: 100vh; align-items: center; justify-content: center; font-family: sans-serif; color: white;}
        video { width: 100%; max-width: 1280px; height: auto; background-color: #111; box-shadow: 0 4px 15px rgba(0,0,0,0.5); }
        .header { position: absolute; top: 15px; left: 15px; background: rgba(0,0,0,0.6); padding: 5px 15px; border-radius: 5px; }
        .live-badge { color: red; font-weight: bold; animation: pulse 2s infinite; }
        @keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0.5; } 100% { opacity: 1; } }
      </style>
    </head>
    <body>
      <div class="header">
        <h3>Siribots <span class="live-badge">● AO VIVO</span></h3>
      </div>
      <video id="video" controls autoplay muted playsinline></video>
      <script>
        const video = document.getElementById('video');
        const videoSrc = '/stream.m3u8';
        
        if (Hls.isSupported()) {
          const hls = new Hls({
            liveSyncDurationCount: 3,
            liveMaxLatencyDurationCount: 5,
            enableWorker: true
          });
          hls.loadSource(videoSrc);
          hls.attachMedia(video);
          hls.on(Hls.Events.MANIFEST_PARSED, function() {
            video.play().catch(e => console.log("Auto-play prevenido pelo navegador."));
          });
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
          video.src = videoSrc;
          video.addEventListener('loadedmetadata', function() {
            video.play();
          });
        }
      </script>
    </body>
    </html>
  `);
});

// Rota 2: Página de Admin (Restrita ao Localhost)
app.get("/admin", adminOnly, (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Siribots - Painel de Controle</title>
      <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f4f7f6; margin: 0; padding: 40px; }
        .card { background: white; max-width: 600px; margin: 0 auto; padding: 30px; border-radius: 10px; box-shadow: 0 5px 20px rgba(0,0,0,0.05); }
        h1 { color: #2c3e50; margin-top: 0; }
        .status-box { padding: 15px; border-radius: 6px; margin-bottom: 15px; font-weight: bold; }
        .status-live { background-color: #d4edda; color: #155724; border: 1px solid #c3e6cb; }
        .status-waiting { background-color: #f8d7da; color: #721c24; border: 1px solid #f5c6cb; }
        .btn { display: inline-block; background: #3498db; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; margin-top: 20px; }
        .btn:hover { background: #2980b9; }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>Painel Hub - Siribots</h1>
        <p>Bem-vindo ao painel administrativo local.</p>
        
        <h3>Status da Transmissão (Odroid):</h3>
        <div id="status-container" class="status-box status-waiting">
          Verificando conexão da placa fonte...
        </div>

        <a href="/" target="_blank" class="btn">Abrir Visualizador do Robô</a>
      </div>

      <script>
        async function fetchStatus() {
          try {
            const response = await fetch('/status');
            const data = await response.json();
            const container = document.getElementById('status-container');
            
            if (data.status === 'live') {
              container.className = 'status-box status-live';
              container.innerHTML = '🟢 SINAL ATIVO - A placa Odroid está transmitindo vídeo.';
            } else {
              container.className = 'status-box status-waiting';
              container.innerHTML = '🔴 AGUARDANDO SINAL - Nenhuma transmissão ativa no momento.';
            }
          } catch (e) {
            console.error('Erro ao buscar status');
          }
        }
        
        // Atualiza a cada 2 segundos
        setInterval(fetchStatus, 2000);
        fetchStatus();
      </script>
    </body>
    </html>
  `);
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

app.get("/status", (req, res) => {
  const now = Date.now();
  const sourceStale = now - lastSourceFrameAt > WAITING_TIMEOUT_MS;
  const isLive = Boolean(activeSource) && !sourceStale;
  const payload = { status: isLive ? "live" : "waiting" };
  res.json(payload);
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

const httpServer = app.listen(HTTP_PORT, "0.0.0.0", () => {
  console.log(`Servidor Web/HLS iniciado na porta :${HTTP_PORT}`);
  console.log(`-> Painel do Robô: http://localhost:${HTTP_PORT}`);
  console.log(`-> Admin (Restrito): http://127.0.0.1:${HTTP_PORT}/admin`);
});

const wss = new WebSocket.Server({ port: WS_PORT }, () => {
  console.log(`WebSocket server apenas para Fonte iniciado na porta :${WS_PORT}`);
});

let activeSource = null;
let lastSourceFrameAt = 0;
let ffmpegProcess = null;

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
}, WAITING_INTERVAL_MS);

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
  httpServer.close();
  stopFfmpeg();
  process.exit(0);
});