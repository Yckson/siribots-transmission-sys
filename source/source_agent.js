require("dotenv").config();
const dgram = require("dgram");
const { spawn } = require("child_process");
const WebSocket = require("ws");

const DISCOVER_SOURCE = "DISCOVER_HUB_SOURCE";
const UDP_PORT_SOURCE = 41001;
const WS_PORT_FALLBACK = 42000;
const DISCOVERY_TIMEOUT_MS = 5000;
const RETRY_DELAY_MS = 2000;

const HUB_IP_ENV = (process.env.HUB_IP || "").trim();
const HUB_WS_PORT_ENV = Number(process.env.HUB_WS_PORT || "");

const CAMERA_NAME = (process.env.CAMERA_NAME || "").trim();
const VIDEO_DEVICE = (process.env.VIDEO_DEVICE || "/dev/video0").trim();
const VIDEO_SIZE = (process.env.VIDEO_SIZE || "640x480").trim();
const FRAME_RATE = (process.env.FRAME_RATE || "30").trim();
const GOP_SIZE = Math.max(1, Math.round(Number.parseInt(FRAME_RATE, 10) / 2));
const FFMPEG_BIN = (process.env.FFMPEG_BIN || "ffmpeg").trim();
const PLATFORM_OVERRIDE = (process.env.SOURCE_PLATFORM || "").trim().toLowerCase();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function discoverHub() {
  if (HUB_IP_ENV) {
    return Promise.resolve({
      hubIp: HUB_IP_ENV,
      wsPort: HUB_WS_PORT_ENV || WS_PORT_FALLBACK,
    });
  }

  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    let timeoutId = null;
    let closed = false;

    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (socket) {
        try {
          socket.close();
        } catch (err) {
          // Ignore close errors.
        }
      }
    };

    const finish = (err, data) => {
      if (closed) return;
      closed = true;
      cleanup();
      if (err) {
        reject(err);
      } else {
        resolve(data);
      }
    };

    timeoutId = setTimeout(() => {
      finish(new Error("Hub nao encontrado."));
    }, DISCOVERY_TIMEOUT_MS);

    socket.on("message", (msg) => {
      if (closed) return;
      const payload = msg.toString("utf8").trim();
      let hubIp = null;
      let wsPort = WS_PORT_FALLBACK;

      try {
        const data = JSON.parse(payload);
        hubIp = data.hubIp;
        wsPort = data.wsPort || WS_PORT_FALLBACK;
      } catch (err) {
        hubIp = payload;
      }

      if (!hubIp) {
        finish(new Error("Resposta invalida do hub."));
        return;
      }

      finish(null, { hubIp, wsPort });
    });

    socket.on("error", (err) => {
      finish(err);
    });

    socket.once("listening", () => {
      try {
        socket.setBroadcast(true);
        const message = Buffer.from(DISCOVER_SOURCE, "utf8");
        socket.send(
          message,
          0,
          message.length,
          UDP_PORT_SOURCE,
          "255.255.255.255",
          (err) => {
            if (err) {
              finish(err);
            }
          }
        );
      } catch (err) {
        finish(err);
      }
    });

    socket.bind(0, "0.0.0.0");
  });
}

function buildFfmpegArgs() {
  const platform = PLATFORM_OVERRIDE || process.platform;

  if (platform === "win32" || platform === "windows") {
    if (!CAMERA_NAME) {
      throw new Error("Set CAMERA_NAME with the DirectShow device name.");
    }

    return [
      "-f",
      "dshow",
      "-video_size",
      VIDEO_SIZE,
      "-framerate",
      FRAME_RATE,
      "-i",
      `video=${CAMERA_NAME}`,
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-tune",
      "zerolatency",
      "-profile:v", // <-- FORÇA O PERFIL SIMPLES
      "baseline",   // <-- PARA COMPATIBILIDADE MOBILE
      "-pix_fmt",   // <-- FORÇA O FORMATO DE CORES UNIVERSAL
      "yuv420p",    // <-- QUE O SNAPDRAGON EXIGE
      "-g",
      `${GOP_SIZE}`,
      "-keyint_min",
      `${GOP_SIZE}`,
      "-sc_threshold",
      "0",
      "-bf",
      "0",
      "-muxdelay",
      "0",
      "-muxpreload",
      "0",
      "-flush_packets",
      "1",
      "-f",
      "mpegts",
      "-",
    ];
  }

  return [
    "-f",
    "v4l2",
    "-video_size",
    VIDEO_SIZE,
    "-framerate",
    FRAME_RATE,
    "-i",
    VIDEO_DEVICE,
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-tune",
    "zerolatency",
    "-g",
    `${GOP_SIZE}`,
    "-keyint_min",
    `${GOP_SIZE}`,
    "-sc_threshold",
    "0",
    "-bf",
    "0",
    "-muxdelay",
    "0",
    "-muxpreload",
    "0",
    "-flush_packets",
    "1",
    "-f",
    "mpegts",
    "-",
  ];
}

function startFfmpeg(onChunk) {
  const args = buildFfmpegArgs();
  const child = spawn(FFMPEG_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });

  child.stdout.on("data", (chunk) => {
    onChunk(chunk);
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8").trim();
    if (text) {
      console.log(`[ffmpeg] ${text}`);
    }
  });

  return child;
}

function streamToHub({ hubIp, wsPort }) {
  return new Promise((resolve) => {
    console.log(`Connecting to hub ws://${hubIp}:${wsPort}`);
    const ws = new WebSocket(`ws://${hubIp}:${wsPort}`);
    let ffmpeg = null;
    let closed = false;

    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (ffmpeg) {
        try {
          ffmpeg.kill("SIGINT");
        } catch (err) {
          // Ignore kill errors.
        }
      }
      try {
        ws.close();
      } catch (err) {
        // Ignore close errors.
      }
      resolve();
    };

    ws.on("open", () => {
      ws.send(JSON.stringify({ role: "source" }));
      try {
        ffmpeg = startFfmpeg((chunk) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(chunk, { binary: true });
          }
        });
      } catch (err) {
        console.error(`FFmpeg start failed: ${err.message}`);
        cleanup();
        return;
      }

      ffmpeg.on("close", (code) => {
        console.log(`FFmpeg exited with code ${code}`);
        cleanup();
      });
    });

    ws.on("close", () => {
      console.log("Hub connection closed.");
      cleanup();
    });

    ws.on("error", (err) => {
      console.error(`WebSocket error: ${err.message}`);
      cleanup();
    });
  });
}

async function run() {
  while (true) {
    try {
      const hubInfo = await discoverHub();
      await streamToHub(hubInfo);
    } catch (err) {
      console.error(`Source error: ${err.message}`);
    }
    await sleep(RETRY_DELAY_MS);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
