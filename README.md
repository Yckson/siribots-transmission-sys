# siribots-transmission-sys
Projeto de transmissao local para o evento do Siribots
## Source (captura e envio)

Requisitos:
- Node.js instalado
- FFmpeg instalado e acessivel no PATH

Instalar dependencias:
```
npm install
```

Rodar o agente Source (Windows / DirectShow):
```
set CAMERA_NAME=Nome da Camera DirectShow
npm run source
```

Variaveis opcionais:
- HUB_IP: IP do hub para pular descoberta UDP
- HUB_WS_PORT: porta WS do hub (padrao 42000)
- VIDEO_SIZE: ex 1280x720
- FRAME_RATE: ex 30
- FFMPEG_BIN: caminho para o ffmpeg
- SOURCE_PLATFORM: windows ou linux (forca modo de captura)
- VIDEO_DEVICE: ex /dev/video0 (para Linux/Odroid)
