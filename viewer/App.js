import React, { useEffect, useRef, useState } from "react";
import { Alert, Button, SafeAreaView, StyleSheet, Text, View } from "react-native";
import dgram from "react-native-udp";

const DISCOVER_VIEWER = "DISCOVER_HUB_CLIENT";
const UDP_PORT_VIEWER = 41002;
const WS_PORT_FALLBACK = 42000;
const DISCOVERY_TIMEOUT_MS = 5000;

export default function App() {
  const [status, setStatus] = useState("Aguardando conexao...");
  const socketRef = useRef(null);
  const wsRef = useRef(null);

  useEffect(() => {
    return () => {
      if (socketRef.current) {
        socketRef.current.close();
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, []);

  const startDiscovery = () => {
    setStatus("Buscando hub na rede...");

    const udpSocket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    socketRef.current = udpSocket;
    let isClosed = false;

    const safeClose = () => {
      if (isClosed) return;
      isClosed = true;
      try { udpSocket.close(); } catch (e) {}
    };

    const timeoutId = setTimeout(() => {
      setStatus("Hub nao encontrado.");
      safeClose();
    }, DISCOVERY_TIMEOUT_MS);

    // 1. Ouvimos mensagens
    udpSocket.on("message", (msg) => {
      clearTimeout(timeoutId);
      const payload = msg.toString("utf8");
      // ... (mantenha a sua lógica de parse do IP aqui) ...
    });

    // 2. Ouvimos erros
    udpSocket.on("error", (err) => {
      clearTimeout(timeoutId);
      setStatus(`Erro UDP: ${err.message}`);
      safeClose();
    });

    // 3. Quando o bind funcionar, ESTE evento dispara, e aí enviamos a mensagem
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
              clearTimeout(timeoutId);
              setStatus(`Erro no envio: ${err.message}`);
              safeClose();
            }
          }
        );
      } catch (err) {
        clearTimeout(timeoutId);
        setStatus(`Falha ao configurar broadcast: ${err.message}`);
        safeClose();
      }
    });

    // 4. Pedimos para o socket abrir na porta 0 (aleatória) e interface 0.0.0.0
    udpSocket.bind(0, "0.0.0.0");
  };

  const connectWebSocket = (hubIp, wsPort) => {
    const ws = new WebSocket(`ws://${hubIp}:${wsPort}`);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus("Conectado ao hub.");
      Alert.alert("Conectado", "Viewer conectado ao hub.");
    };

    ws.onerror = () => {
      setStatus("Falha ao conectar no WebSocket.");
    };

    ws.onclose = () => {
      setStatus("Conexao encerrada.");
    };
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.card}>
        <Text style={styles.title}>Siribots Viewer</Text>
        <Text style={styles.status}>{status}</Text>
        <Button title="Conectar" onPress={startDiscovery} />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#111827",
    alignItems: "center",
    justifyContent: "center",
  },
  card: {
    width: "90%",
    backgroundColor: "#1f2937",
    padding: 24,
    borderRadius: 16,
    gap: 16,
  },
  title: {
    color: "#f9fafb",
    fontSize: 24,
    fontWeight: "700",
  },
  status: {
    color: "#e5e7eb",
    fontSize: 16,
  },
});
