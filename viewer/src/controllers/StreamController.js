import { useCallback, useEffect, useRef, useState } from "react";
import { createConnectionState } from "../models/ConnectionState";
import DiscoveryService from "../services/DiscoveryService";
import {
  HLS_PATH_FALLBACK,
  HLS_PORT_FALLBACK,
  HLS_GRACE_PERIOD_MS,
  PLAYBACK_FAILURE_THRESHOLD,
  RECONNECT_DELAY_MS,
  STATUS_FAILURE_THRESHOLD,
  STATUS_POLL_INTERVAL_MS,
} from "../config/constants";

const useStreamController = () => {
  const [state, setState] = useState(createConnectionState());
  const discoveryRef = useRef(new DiscoveryService());
  const reconnectTimerRef = useRef(null);
  const statusTimerRef = useRef(null);
  const graceTimerRef = useRef(null);
  const consecutiveFailuresRef = useRef(0);
  const liveStatusRef = useRef(false);
  const playbackFailureRef = useRef(0);
  const hubInfoRef = useRef({ baseUrl: null, hlsUrl: null });
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

  const clearGraceTimer = useCallback(() => {
    if (graceTimerRef.current) {
      clearTimeout(graceTimerRef.current);
      graceTimerRef.current = null;
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

  const scheduleShowVideo = useCallback(() => {
    clearGraceTimer();
    graceTimerRef.current = setTimeout(() => {
      setStateSafe({ showVideo: true });
    }, HLS_GRACE_PERIOD_MS);
  }, [clearGraceTimer, setStateSafe]);

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
          scheduleShowVideo();
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
        clearGraceTimer();
        setStateSafe({
          status: "Aguardando transmissao...",
          isLive: false,
          showVideo: false,
          checking: true,
          lastError: null,
        });
      }
    } catch (error) {
      consecutiveFailuresRef.current += 1;
      if (consecutiveFailuresRef.current >= STATUS_FAILURE_THRESHOLD) {
        liveStatusRef.current = false;
        clearGraceTimer();
        setStateSafe({
          status: "Hub indisponivel. Tentando novamente...",
          isLive: false,
          showVideo: false,
          checking: true,
          lastError: error?.message || "Falha ao consultar status",
        });
      }
    }
  }, [clearGraceTimer, scheduleShowVideo, setStateSafe]);

  const startStatusPolling = useCallback(
    (baseUrl, hlsUrl) => {
      hubInfoRef.current = { baseUrl, hlsUrl };
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
    clearGraceTimer();
    consecutiveFailuresRef.current = 0;
    liveStatusRef.current = false;
    playbackFailureRef.current = 0;

    setStateSafe({
      status: "Buscando hub na rede...",
      hubIp: null,
      hlsUrl: null,
      isLive: false,
      showVideo: false,
      checking: true,
      lastError: null,
    });

    discoveryRef.current
      .discoverHub()
      .then(({ hubIp, hlsPort, hlsPath }) => {
        const resolvedPort = hlsPort || HLS_PORT_FALLBACK;
        const resolvedPath = hlsPath || HLS_PATH_FALLBACK;
        const baseUrl = `http://${hubIp}:${resolvedPort}`;
        const hlsUrl = `${baseUrl}${resolvedPath}`;
        setStateSafe({
          status: `Hub encontrado: ${hubIp}`,
          hubIp,
          hlsUrl,
          checking: true,
          isLive: false,
          showVideo: false,
          lastError: null,
        });
        startStatusPolling(baseUrl, hlsUrl);
      })
      .catch((err) => {
        if (err?.message === "Discovery cancelled") return;
        setStateSafe({ status: err?.message || "Falha na descoberta." });
        scheduleReconnect("Hub nao encontrado. Tentando novamente...");
      });
  }, [
    clearReconnectTimer,
    clearStatusTimer,
    clearGraceTimer,
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
      clearGraceTimer();
      discoveryRef.current.cancel();
    };
  }, [clearReconnectTimer, clearStatusTimer, clearGraceTimer]);

const handlePlaybackError = useCallback((errorMsg) => {
    const errorMessage = typeof errorMsg === 'string' ? errorMsg : JSON.stringify(errorMsg);
    
    // 1. FORÇA A EXIBIÇÃO IMEDIATA: Ignora a tolerância só para mostrar na tela o que houve
    setStateSafe({ lastError: `ERRO FATAL A: ${errorMessage}` });
    
    const baseUrl = hubInfoRef.current.baseUrl;
    const hlsUrl = hubInfoRef.current.hlsUrl;
    if (!baseUrl || !hlsUrl) return;
    
    playbackFailureRef.current += 1;
    if (playbackFailureRef.current < PLAYBACK_FAILURE_THRESHOLD) {
      return; 
    }

    playbackFailureRef.current = 0;
    setStateSafe({
      status: "Transmissao interrompida. Rechecando...",
      showVideo: false,
      checking: true,
    });
    liveStatusRef.current = false;
    scheduleShowVideo();
  }, [scheduleShowVideo, setStateSafe]);

  const handlePlaybackStatus = useCallback(
    (status) => {
      // 2. Pega erros silenciosos de status ANTES do bloqueio do isLoaded
      if (status?.error) {
        setStateSafe({ lastError: `ERRO FATAL B: ${status.error}` });
      }

      if (!status?.isLoaded) return;
      
      if (status.isPlaying || status.positionMillis > 0) {
        playbackFailureRef.current = 0;
        if (!state.showVideo) {
          setStateSafe({ showVideo: true });
        }
      }
    },
    [setStateSafe, state.showVideo]
  );

  return {
    state,
    startDiscovery,
    handlePlaybackError,
    handlePlaybackStatus,
  };
};

export default useStreamController;
