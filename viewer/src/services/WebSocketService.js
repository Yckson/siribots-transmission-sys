class WebSocketService {
  constructor() {
    this.ws = null;
  }

  connect(hubIp, wsPort, handlers) {
    this.disconnect();
    const ws = new WebSocket(`ws://${hubIp}:${wsPort}`);
    this.ws = ws;

    ws.onopen = () => {
      if (handlers?.onOpen) handlers.onOpen(ws);
    };

    ws.onmessage = (event) => {
      if (handlers?.onMessage) handlers.onMessage(event);
    };

    ws.onerror = (event) => {
      if (handlers?.onError) handlers.onError(event);
    };

    ws.onclose = (event) => {
      if (handlers?.onClose) handlers.onClose(event);
    };
  }

  disconnect() {
    if (!this.ws) return;
    try {
      this.ws.close();
    } catch (e) {
      // Ignore close errors.
    }
    this.ws = null;
  }
}

export default WebSocketService;
