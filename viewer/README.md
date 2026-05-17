# Viewer (fase 1)

Viewer Expo com descoberta via UDP e alerta quando conecta no hub.

## Setup

1) Instale dependencias:

```
npm install
```

2) Gere uma dev build com modulos nativos (react-native-udp):

```
expo prebuild
expo run:android
```

3) Rode o app:

```
npm start
```

## Observacoes

- A descoberta usa broadcast UDP para 255.255.255.255:41002.
- O hub responde com JSON contendo IP e porta WebSocket.
