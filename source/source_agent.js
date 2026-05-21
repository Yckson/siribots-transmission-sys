require("dotenv").config();
const dgram = require("dgram");
const WebSocket = require("ws");
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');

// Configurações de Discovery (Mantidas)
const DISCOVER_SOURCE = "DISCOVER_HUB_SOURCE";
const UDP_PORT_SOURCE = 41001;
const WS_PORT_FALLBACK = 42000;
const DISCOVERY_TIMEOUT_MS = 5000;
const RETRY_DELAY_MS = 2000;

const HUB_IP_ENV = (process.env.HUB_IP || "").trim();
const HUB_WS_PORT_ENV = Number(process.env.HUB_WS_PORT || "");

// Configurações da Serial
const SERIAL_PATH = process.env.SERIAL_PORT || "/dev/ttyACM0";
const BAUD_RATE = 9600;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// Função discoverHub() original mantida intocada (reaproveitada do seu código)
function discoverHub() {
  if (HUB_IP_ENV) return Promise.resolve({ hubIp: HUB_IP_ENV, wsPort: HUB_WS_PORT_ENV || WS_PORT_FALLBACK });
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    let timeoutId = null; let closed = false;
    const cleanup = () => { if (timeoutId) clearTimeout(timeoutId); if (socket) { try { socket.close(); } catch (err) {} } };
    const finish = (err, data) => { if (closed) return; closed = true; cleanup(); if (err) reject(err); else resolve(data); };
    timeoutId = setTimeout(() => finish(new Error("Hub nao encontrado.")), DISCOVERY_TIMEOUT_MS);
    socket.on("message", (msg) => {
      const payload = msg.toString("utf8").trim();
      let hubIp = null, wsPort = WS_PORT_FALLBACK;
      try { const data = JSON.parse(payload); hubIp = data.hubIp; wsPort = data.wsPort || WS_PORT_FALLBACK; } 
      catch (err) { hubIp = payload; }
      if (!hubIp) finish(new Error("Resposta invalida do hub.")); else finish(null, { hubIp, wsPort });
    });
    socket.on("error", finish);
    socket.once("listening", () => {
      try {
        socket.setBroadcast(true);
        const message = Buffer.from(DISCOVER_SOURCE, "utf8");
        socket.send(message, 0, message.length, UDP_PORT_SOURCE, "255.255.255.255", (err) => { if (err) finish(err); });
      } catch (err) { finish(err); }
    });
    socket.bind(0, "0.0.0.0");
  });
}

function connectAndBridge({ hubIp, wsPort }) {
  return new Promise((resolve) => {
    console.log(`[REDE] Conectando ao Hub WS: ws://${hubIp}:${wsPort}`);
    const ws = new WebSocket(`ws://${hubIp}:${wsPort}`);
    
    let port;
    try {
      port = new SerialPort({ path: SERIAL_PATH, baudRate: BAUD_RATE });
      console.log(`[SERIAL] Escutando o Arduino na porta ${SERIAL_PATH}`);
    } catch (err) {
      console.error(`[SERIAL ERRO] ${err.message}`);
    }

    const cleanup = () => {
      if (port && port.isOpen) port.close();
      if (ws.readyState === WebSocket.OPEN) ws.close();
      resolve();
    };

    ws.on("open", () => {
      // O tipo 'telemetry' avisa o hub que esta placa não envia vídeo, apenas dados
      ws.send(JSON.stringify({ role: "source", type: "telemetry" }));
    });

    // 1. Receber Comandos do Hub (Admin) e enviar para o Arduino
    ws.on("message", (data, isBinary) => {
      if (!isBinary) {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.cmd === "START_RACE" && port && port.isOpen) {
            console.log("[COMANDO] Iniciar nova corrida!");
            port.write("S\n"); // Envia apenas um 'S' para o Arduino
          }
        } catch (e) { }
      }
    });

    // 2. Ler Arduino e enviar para o Hub
    if (port) {
      const parser = port.pipe(new ReadlineParser({ delimiter: '\r\n' }));
      parser.on('data', (linha) => {
        console.log(`[ARDUINO] Leu: ${linha}`);
        if (ws.readyState === WebSocket.OPEN) {
            // Envia o dado via WS para o servidor
            ws.send(JSON.stringify({ event: "arduino_data", payload: linha }));
        }
      });
      port.on('error', (err) => console.error(`[SERIAL ERRO] ${err.message}`));
    }

    ws.on("close", () => { console.log("[REDE] Conexão com o Hub fechada."); cleanup(); });
    ws.on("error", (err) => { console.error(`[REDE ERRO] ${err.message}`); cleanup(); });
  });
}

async function run() {
  while (true) {
    try {
      const hubInfo = await discoverHub();
      await connectAndBridge(hubInfo);
    } catch (err) {
      console.error(`[ERRO] ${err.message}`);
    }
    await sleep(RETRY_DELAY_MS);
  }
}

run().catch(console.error);