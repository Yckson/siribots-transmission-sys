import { useCallback, useEffect, useRef, useState } from "react";
import { createConnectionState } from "../models/ConnectionState";
import DiscoveryService from "../services/DiscoveryService";
import WebSocketService from "../services/WebSocketService";
import { RECONNECT_DELAY_MS } from "../config/constants";

const useStreamController = () => {
  const [state, setState] = useState(createConnectionState());
  const discoveryRef = useRef(new DiscoveryService());
  const wsRef = useRef(new WebSocketService());
  const reconnectTimerRef = useRef(null);
  const startDiscoveryRef = useRef(() => {});
  const isMountedRef = useRef(true);

  const setStateSafe = useCallback((partial) => {
    if (!isMountedRef.current) return;
    setState((prev) => ({ ...prev, ...partial }));
  }, []);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const scheduleReconnect = useCallback(
    (reason) => {
      if (!isMountedRef.current) return;
      clearReconnectTimer();
      setStateSafe({ status: reason, connected: false });
      reconnectTimerRef.current = setTimeout(() => {
        startDiscoveryRef.current();
      }, RECONNECT_DELAY_MS);
    },
    [clearReconnectTimer, setStateSafe]
  );

  const connectWebSocket = useCallback(
    (hubIp, wsPort) => {
      setStateSafe({ status: "Conectando ao hub..." });
      wsRef.current.connect(hubIp, wsPort, {
        onOpen: (ws) => {
          ws.send(JSON.stringify({ role: "viewer" }));
          setStateSafe({ status: "Conectado ao hub.", connected: true });
        },
        onError: () => {
          setStateSafe({ status: "Falha ao conectar.", connected: false });
          scheduleReconnect("Falha ao conectar. Tentando novamente...");
        },
        onClose: (event) => {
          const code = event?.code ?? "-";
          setStateSafe({
            status: `Conexao encerrada. (Codigo: ${code})`,
            connected: false,
          });
          scheduleReconnect("Conexao perdida. Tentando novamente...");
        },
      });
    },
    [scheduleReconnect, setStateSafe]
  );

  const startDiscovery = useCallback(() => {
    clearReconnectTimer();
    wsRef.current.disconnect();
    discoveryRef.current.cancel();

    setStateSafe({
      status: "Buscando hub na rede...",
      connected: false,
      hubIp: null,
      wsPort: null,
    });

    discoveryRef.current
      .discoverHub()
      .then(({ hubIp, wsPort }) => {
        setStateSafe({
          status: `Hub encontrado: ${hubIp}`,
          hubIp,
          wsPort,
        });
        connectWebSocket(hubIp, wsPort);
      })
      .catch((err) => {
        if (err?.message === "Discovery cancelled") return;
        setStateSafe({ status: err?.message || "Falha na descoberta." });
        scheduleReconnect("Hub nao encontrado. Tentando novamente...");
      });
  }, [clearReconnectTimer, connectWebSocket, scheduleReconnect, setStateSafe]);

  startDiscoveryRef.current = startDiscovery;

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      clearReconnectTimer();
      discoveryRef.current.cancel();
      wsRef.current.disconnect();
    };
  }, [clearReconnectTimer]);

  return {
    state,
    startDiscovery,
  };
};

export default useStreamController;
