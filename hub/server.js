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

function getLocalIp() {
  const interfaces = os.networkInterfaces();
  const gatewayIp = (process.env.GATEWAY_IP || "").trim();

  if (!gatewayIp) {
    console.warn("GATEWAY_IP not set in .env, falling back to 127.0.0.1");
    return "127.0.0.1";
  }

  const gatewayParts = gatewayIp.split(".");
  if (gatewayParts.length !== 4) {
    console.warn("GATEWAY_IP format invalid, falling back to 127.0.0.1");
    return "127.0.0.1";
  }

  const gatewayPrefix = gatewayParts.slice(0, 3).join(".");

  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name]) {
      if (net.family === "IPv4" && !net.internal) {
        const ipPrefix = net.address.split(".").slice(0, 3).join(".");
        if (ipPrefix === gatewayPrefix) {
          return net.address;
        }
      }
    }
  }

  console.warn("No IPv4 match for GATEWAY_IP subnet, falling back to 127.0.0.1");
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

    const response = JSON.stringify({
      hubIp: getLocalIp(),
      wsPort: WS_PORT,
      hlsPort: HTTP_PORT,
      hlsPath: `/${HLS_PLAYLIST}`,
      role,
    });

    socket.send(response, rinfo.port, rinfo.address);
    const now = new Date().toISOString();
    console.log(`[${now}] ${role} discovery from ${rinfo.address}:${rinfo.port}`);
  });

  socket.bind(port, () => {
    console.log(`UDP ${role} listener on 0.0.0.0:${port}`);
  });

  return socket;
}

const sourceListener = createUdpListener(UDP_PORT_SOURCE, "source");
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

function buildWaitingPlaylist() {
  const targetDuration = Math.max(1, Math.ceil(HLS_TIME_SECONDS));
  
  // Simula uma sequência contínua baseada no tempo real para o player não desistir
  const seq = Math.floor(Date.now() / 1000 / targetDuration) % 1000;

  return [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-ALLOW-CACHE:NO",
    `#EXT-X-TARGETDURATION:${targetDuration}`,
    `#EXT-X-MEDIA-SEQUENCE:${seq}`, // Sequência dinâmica!
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
    "-loglevel",
    "warning",
    "-f",
    "lavfi",
    "-i",
    `color=c=black:s=${HLS_WAITING_SIZE}:r=${HLS_WAITING_FPS}`,
    "-t",
    "1",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-tune",
    "zerolatency",
    "-pix_fmt",
    "yuv420p",
    "-f",
    "mpegts",
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
  console.log(`[${new Date().toISOString()}] /status`, payload);
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
  console.log(`HTTP HLS server listening on :${HTTP_PORT}`);
});

const wss = new WebSocket.Server({ port: WS_PORT }, () => {
  console.log(`WebSocket server listening on :${WS_PORT}`);
});

let activeSource = null;
let lastSourceFrameAt = 0;
let ffmpegProcess = null;

function buildFfmpegArgs() {
  const playlistPath = path.join(HLS_DIR, HLS_PLAYLIST);
  const segmentPath = path.join(HLS_DIR, HLS_SEGMENT_PATTERN);

  return [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-fflags",
    "nobuffer+genpts",
    "-analyzeduration", "1000000", // Acelera a leitura do pipe
    "-probesize", "1000000",
    "-f",
    HLS_INPUT_FORMAT,
    "-i",
    "pipe:0",
    "-c:v",
    "copy",
    "-an",
    "-hls_time",
    `${HLS_TIME_SECONDS}`,
    "-hls_list_size",
    `${HLS_LIST_SIZE}`,
    "-hls_flags",
    "delete_segments+temp_file", // Flags corrigidas (sem append_list e split_by_time)
    "-hls_segment_filename",
    segmentPath,
    playlistPath,
  ];
}

function startFfmpeg() {
  if (ffmpegProcess) {
    return;
  }

  clearHlsDir();
  const args = buildFfmpegArgs();

  ffmpegProcess = spawn(process.env.FFMPEG_PATH || "ffmpeg", args, {
    stdio: ["pipe", "ignore", "pipe"],
  });

  ffmpegProcess.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8").trim();
    if (text) {
      console.log(`[FFmpeg] ${text}`);
    }
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
  if (!ffmpegProcess) {
    return;
  }

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
  const now = new Date().toISOString();
  const remote = req.socket.remoteAddress || "unknown";
  let role = "unknown";

  console.log(`[${now}] WS connection from ${remote}`);

  ws.on("message", (data, isBinary) => {
    if (role === "unknown" && !isBinary) {
      let payload;
      try {
        payload = JSON.parse(data.toString("utf8"));
      } catch (error) {
        ws.close(1008, "Invalid handshake");
        return;
      }

      if (payload?.role === "source") {
        role = "source";
        if (activeSource && activeSource !== ws) {
          activeSource.close(1012, "Replaced by new source");
        }
        activeSource = ws;
        lastSourceFrameAt = Date.now();
        console.log(`[${new Date().toISOString()}] Source connected from ${remote}`);
        return;
      }

      if (payload?.role === "viewer") {
        role = "viewer";
        console.log(`[${new Date().toISOString()}] Viewer attempted WS from ${remote}`);
        ws.close(1008, "HLS only");
        return;
      }

      ws.close(1008, "Unknown role");
      return;
    }

    if (role === "source" && isBinary) {
      lastSourceFrameAt = Date.now();
      startFfmpeg();
      if (ffmpegProcess?.stdin?.writable) {
        ffmpegProcess.stdin.write(data);
      }
    }
  });

  ws.on("close", () => {
    const closedAt = new Date().toISOString();
    if (role === "viewer") {
      console.log(`[${closedAt}] Viewer disconnected from ${remote}`);
    } else if (role === "source") {
      if (activeSource === ws) {
        activeSource = null;
      }
      stopFfmpeg();
      console.log(`[${closedAt}] Source disconnected from ${remote}`);
    } else {
      console.log(`[${closedAt}] WS disconnected from ${remote}`);
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
