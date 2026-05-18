import dgram from "react-native-udp";
import {
  DISCOVER_VIEWER,
  DISCOVERY_TIMEOUT_MS,
  HLS_PATH_FALLBACK,
  HLS_PORT_FALLBACK,
  UDP_PORT_VIEWER,
} from "../config/constants";

class DiscoveryService {
  constructor() {
    this.socket = null;
    this.timeoutId = null;
    this.isClosed = false;
    this.pendingReject = null;
    this.pendingResolve = null;
  }

  cancel() {
    if (this.pendingReject) {
      this.pendingReject(new Error("Discovery cancelled"));
    }
    this.cleanup();
  }

  cleanup() {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }

    if (this.socket) {
      try {
        this.socket.close();
      } catch (e) {
        // Ignore close errors.
      }
      this.socket = null;
    }

    this.isClosed = false;
    this.pendingReject = null;
    this.pendingResolve = null;
  }

  discoverHub() {
    this.cancel();

    return new Promise((resolve, reject) => {
      this.pendingResolve = resolve;
      this.pendingReject = reject;

      const udpSocket = dgram.createSocket({ type: "udp4", reuseAddr: true });
      this.socket = udpSocket;
      this.isClosed = false;

      const safeClose = () => {
        if (this.isClosed) return;
        this.isClosed = true;
        this.cleanup();
      };

      const fail = (err) => {
        if (this.isClosed) return;
        reject(err);
        safeClose();
      };

      this.timeoutId = setTimeout(() => {
        fail(new Error("Hub nao encontrado."));
      }, DISCOVERY_TIMEOUT_MS);

      udpSocket.on("message", (msg) => {
        if (this.isClosed) return;
        clearTimeout(this.timeoutId);
        const payload = msg.toString("utf8");
        let hubIp = null;
        let hlsPort = HLS_PORT_FALLBACK;
        let hlsPath = HLS_PATH_FALLBACK;

        try {
          const data = JSON.parse(payload);
          hubIp = data.hubIp;
          hlsPort = data.hlsPort || HLS_PORT_FALLBACK;
          hlsPath = data.hlsPath || HLS_PATH_FALLBACK;
        } catch (err) {
          hubIp = payload.trim();
        }

        if (!hubIp) {
          fail(new Error("Resposta invalida do hub."));
          return;
        }

        resolve({ hubIp, hlsPort, hlsPath });
        safeClose();
      });

      udpSocket.on("error", (err) => {
        fail(err);
      });

      udpSocket.once("listening", () => {
        try {
          udpSocket.setBroadcast(true);
          const message = DISCOVER_VIEWER;
          udpSocket.send(
            message,
            0,
            message.length,
            UDP_PORT_VIEWER,
            "255.255.255.255",
            (err) => {
              if (err) {
                fail(err);
              }
            }
          );
        } catch (err) {
          fail(err);
        }
      });

      udpSocket.bind(0, "0.0.0.0");
    });
  }
}

export default DiscoveryService;
