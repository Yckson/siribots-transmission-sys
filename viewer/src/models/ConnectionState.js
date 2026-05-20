export const createConnectionState = () => ({
  status: "Aguardando conexao...",
  hubIp: null,
  hubUrl: null,
  isLive: false,
  checking: false,
  lastError: null,
});
