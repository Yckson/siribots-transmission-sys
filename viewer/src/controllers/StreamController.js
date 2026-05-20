import { useCallback, useEffect, useRef, useState } from "react";
import { createConnectionState } from "../models/ConnectionState";
import DiscoveryService from "../services/DiscoveryService";
import {
  HLS_PORT_FALLBACK,
  RECONNECT_DELAY_MS,
  STATUS_FAILURE_THRESHOLD,
  STATUS_POLL_INTERVAL_MS,
} from "../config/constants";

const useStreamController = () => {
  const [state, setState] = useState(createConnectionState());
  const discoveryRef = useRef(new DiscoveryService());
  const reconnectTimerRef = useRef(null);
  const statusTimerRef = useRef(null);
  const consecutiveFailuresRef = useRef(0);
  const liveStatusRef = useRef(false);
  const hubInfoRef = useRef({ baseUrl: null });
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

  const clearStatusTimer = useCallback(() => {
    if (statusTimerRef.current) {
      clearInterval(statusTimerRef.current);
      statusTimerRef.current = null;
    }
  }, []);

  const scheduleReconnect = useCallback(
    (reason) => {
      if (!isMountedRef.current) return;
      clearReconnectTimer();
      setStateSafe({ status: reason });
      reconnectTimerRef.current = setTimeout(() => {
        startDiscoveryRef.current();
      }, RECONNECT_DELAY_MS);
    },
    [clearReconnectTimer, setStateSafe]
  );

  const pollStatus = useCallback(async () => {
    const baseUrl = hubInfoRef.current.baseUrl;
    if (!baseUrl) return;

    try {
      const response = await fetch(`${baseUrl}/status`);
      if (!response.ok) {
        throw new Error("Status indisponivel");
      }

      const data = await response.json();
      if (data?.status === "live") {
        consecutiveFailuresRef.current = 0;
        if (!liveStatusRef.current) {
          liveStatusRef.current = true;
          setStateSafe({
            status: "Transmissao ativa.",
            isLive: true,
            checking: false,
            lastError: null,
          });
        } else {
          setStateSafe({
            status: "Transmissao ativa.",
            isLive: true,
            checking: false,
          });
        }
      } else {
        consecutiveFailuresRef.current = 0;
        liveStatusRef.current = false;
        setStateSafe({
          status: "Aguardando transmissao...",
          isLive: false,
          checking: true,
          lastError: null,
        });
      }
    } catch (error) {
      consecutiveFailuresRef.current += 1;
      if (consecutiveFailuresRef.current >= STATUS_FAILURE_THRESHOLD) {
        liveStatusRef.current = false;
        setStateSafe({
          status: "Hub indisponivel. Tentando novamente...",
          isLive: false,
          checking: true,
          lastError: error?.message || "Falha ao consultar status",
        });
      }
    }
  }, [setStateSafe]);

  const startStatusPolling = useCallback(
    (baseUrl) => {
      hubInfoRef.current = { baseUrl };
      clearStatusTimer();
      pollStatus();
      statusTimerRef.current = setInterval(pollStatus, STATUS_POLL_INTERVAL_MS);
    },
    [clearStatusTimer, pollStatus]
  );

  const startDiscovery = useCallback(() => {
    clearReconnectTimer();
    discoveryRef.current.cancel();
    clearStatusTimer();
    consecutiveFailuresRef.current = 0;
    liveStatusRef.current = false;

    setStateSafe({
      status: "Buscando hub na rede...",
      hubIp: null,
      hubUrl: null,
      isLive: false,
      checking: true,
      lastError: null,
    });

    discoveryRef.current
      .discoverHub()
      .then(({ hubIp, hlsPort }) => {
        const resolvedPort = hlsPort || HLS_PORT_FALLBACK;
        const baseUrl = `http://${hubIp}:${resolvedPort}`;
        const hubUrl = `${baseUrl}/`;
        setStateSafe({
          status: `Hub encontrado: ${hubIp}`,
          hubIp,
          hubUrl,
          checking: true,
          isLive: false,
          lastError: null,
        });
        startStatusPolling(baseUrl);
      })
      .catch((err) => {
        if (err?.message === "Discovery cancelled") return;
        setStateSafe({ status: err?.message || "Falha na descoberta." });
        scheduleReconnect("Hub nao encontrado. Tentando novamente...");
      });
  }, [
    clearReconnectTimer,
    clearStatusTimer,
    scheduleReconnect,
    setStateSafe,
    startStatusPolling,
  ]);

  startDiscoveryRef.current = startDiscovery;

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      clearReconnectTimer();
      clearStatusTimer();
      discoveryRef.current.cancel();
    };
  }, [clearReconnectTimer, clearStatusTimer]);

  return {
    state,
    startDiscovery,
  };
};

export default useStreamController;
