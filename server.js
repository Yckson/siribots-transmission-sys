const dgram = require("dgram");
const os = require("os");
const WebSocket = require("ws");

const DISCOVER_SOURCE = "DISCOVER_HUB_SOURCE";
const DISCOVER_VIEWER = "DISCOVER_HUB_CLIENT";

const UDP_PORT_SOURCE = 41001;
const UDP_PORT_VIEWER = 41002;
const WS_PORT = 42000;

function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name]) {
      if (net.family === "IPv4" && !net.internal) {
        return net.address;
      }
    }
  }
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

wss.on("connection", (ws, req) => {
  const now = new Date().toISOString();
  const remote = req.socket.remoteAddress || "unknown";
  console.log(`[${now}] Viewer connected from ${remote}`);

  ws.on("close", () => {
    const closedAt = new Date().toISOString();
    console.log(`[${closedAt}] Viewer disconnected from ${remote}`);
  });
});

process.on("SIGINT", () => {
  sourceListener.close();
  viewerListener.close();
  wss.close();
  process.exit(0);
});
