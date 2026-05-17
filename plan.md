Plano de Projeto: Sistema de Streaming de Vídeo Centralizado (Hub-and-Spoke)

Objetivo: Desenvolver uma arquitetura distribuída de streaming de vídeo para uma rede local isolada (sem internet). Um Servidor Central (Hub) gerencia as conexões, recebendo fluxos de vídeo de Agentes de Fonte (Produtores) e retransmitindo para Agentes Clientes, que serão aplicativos nativos móveis e desktop. Todos os nós utilizam descoberta de rede via UDP para localizar o Hub dinamicamente.

Arquitetura do Sistema

Servidor Central (Hub): Roda no WSL (Node.js) ou outro servidor na rede. É o ponto de encontro.

Agente Fonte (Source): Computador Windows, Placa Odroid ou outro dispositivo. Captura o vídeo via hardware e envia para o Hub.

Agente Cliente (Viewer App): Aplicativo Mobile (e futuramente Desktop) instalado nos dispositivos dos usuários. Descobre o Hub e exibe o vídeo.

Fase 1: O Servidor Central (Hub)

O Hub será o coração do sistema, roteando dados.

1.1. Módulo de Descoberta (UDP Multi-Porta):

Ação: Criar dois listeners UDP distintos no servidor Node.js.

Porta A (ex: 41001): Escuta mensagens de Fontes (DISCOVER_HUB_SOURCE).

Porta B (ex: 41002): Escuta mensagens de Clientes (DISCOVER_HUB_CLIENT).

Ação: Responder a ambos com o IP local do Hub e as respectivas portas TCP/WebSocket para conexão, encerrando a comunicação UDP em seguida.

1.2. Módulo de Roteamento (WebSockets/TCP):

Ação: Criar um servidor (Socket.io/TCP) para receber o stream binário das Fontes.

Ação: Criar um servidor (Socket.io/TCP) para gerenciar os Clientes conectados e retransmitir (broadcast) o vídeo em tempo real.

Fase 2: O Agente Fonte de Vídeo (Windows / Odroid)

Este agente faz a ponte entre o hardware e o Servidor Central.

2.1. Descoberta de Rede:

Ação: Script (Python/Node.js/C++) faz broadcast UDP na Porta A para achar o Hub e armazena o IP.

2.2. Captura e Injeção (FFmpeg):

Ação: O agente usa o FFmpeg para ler a câmera local (DirectShow no Windows ou /dev/video0 na Odroid).

Ação: O FFmpeg codifica o vídeo e o script empurra esse fluxo continuamente via rede (TCP/WebSocket) para o IP do Servidor Central.

Fase 3: O Agente Cliente (Aplicativo Mobile/Desktop)

Para operar em rede isolada e ter acesso nativo ao envio de UDP, o Cliente será um aplicativo desenvolvido em React Native utilizando Expo Development Builds (EAS). Isso permite o uso de módulos nativos mantendo o hot-reload durante o desenvolvimento.

3.1. Configuração do App (Expo):

Ação: Criar o projeto via Expo e configurar uma Development Build customizada para incluir a biblioteca nativa de UDP (react-native-udp).

3.2. Descoberta de Rede Nativa:

Ação: Ao abrir o app, o usuário clica em "Conectar" (ou ocorre automaticamente). O app faz o broadcast UDP na Porta B (ex: 41002).

Ação: O app recebe o IP do Hub e encerra sua busca UDP.

3.3. Recepção e Exibição de Vídeo:

Ação: O aplicativo abre uma conexão TCP/WebSocket no IP descoberto.

Ação: Utiliza um componente de Video Player nativo (react-native-video ou expo-av) para receber os pacotes do stream e renderizar na tela, garantindo performance e controle sobre o buffer.

Fase 4: Migração e Testes de Hardware

4.1. Setup da Odroid XU4 (Fonte):

Ação: Instalar Ubuntu e FFmpeg na placa Odroid. Rodar o Agente Fonte nela, apontando para /dev/video0.

4.2. Teste de Carga do Hub (WSL):

Ação: Validar quantos "Viewer Apps" (celulares/PCs) o Servidor Node.js no WSL aguenta servindo o vídeo simultaneamente sem gargalos de rede.

Fase 5: Refinamentos (Futuro)

Múltiplas Salas: Permitir que o Hub gerencie várias Fontes diferentes, enviando uma lista de "Câmeras Disponíveis" para o Aplicativo Cliente escolher.

Segurança Básica: Adicionar uma camada de handshake simples para evitar conexões indesejadas na rede local.