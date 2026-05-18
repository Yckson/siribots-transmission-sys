export const createConnectionState = () => ({
  status: "Aguardando conexao...",
  hubIp: null,
  hlsUrl: null,
  isLive: false,
  showVideo: false,
  checking: false,
  lastError: null,
});
