const dgram = require("dgram");
const os = require("os");
const WebSocket = require("ws");
require("dotenv").config();

const DISCOVER_SOURCE = "DISCOVER_HUB_SOURCE";
const DISCOVER_VIEWER = "DISCOVER_HUB_CLIENT";

const UDP_PORT_SOURCE = 41001;
const UDP_PORT_VIEWER = 41002;
const WS_PORT = 42000;
const WAITING_INTERVAL_MS = 1000;
const WAITING_TIMEOUT_MS = 2000;

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

const wss = new WebSocket.Server({ port: WS_PORT }, () => {
  console.log(`WebSocket server listening on :${WS_PORT}`);
});

const viewers = new Set();
let activeSource = null;
let lastSourceFrameAt = 0;

function broadcastToViewers(payload, options) {
  for (const viewer of viewers) {
    if (viewer.readyState === WebSocket.OPEN) {
      viewer.send(payload, options);
    }
  }
}

function broadcastWaitingStatus() {
  const message = JSON.stringify({ status: "waiting" });
  broadcastToViewers(message);
}

setInterval(() => {
  const now = Date.now();
  const sourceStale = now - lastSourceFrameAt > WAITING_TIMEOUT_MS;
  if (!activeSource || sourceStale) {
    broadcastWaitingStatus();
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
        viewers.add(ws);
        console.log(`[${new Date().toISOString()}] Viewer connected from ${remote}`);
        return;
      }

      ws.close(1008, "Unknown role");
      return;
    }

    if (role === "source" && isBinary) {
      lastSourceFrameAt = Date.now();
      broadcastToViewers(data, { binary: true });
    }
  });

  ws.on("close", () => {
    const closedAt = new Date().toISOString();
    if (role === "viewer") {
      viewers.delete(ws);
      console.log(`[${closedAt}] Viewer disconnected from ${remote}`);
    } else if (role === "source") {
      if (activeSource === ws) {
        activeSource = null;
      }
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
  process.exit(0);
});
