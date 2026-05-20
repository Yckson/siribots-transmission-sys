import React, { useState } from "react";
import { ActivityIndicator, Text, TouchableOpacity, View, StatusBar } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";

import * as ScreenOrientation from 'expo-screen-orientation';

const ViewerScreen = ({ state, navigation }) => {
  const connectionLabel = state.isLive ? "Ao vivo" : "Aguardando";
  
  const [isFullscreen, setIsFullscreen] = useState(false);

  const handleWebViewMessage = (event) => {
    const mensagem = event.nativeEvent.data;

    if (mensagem === 'fullscreen') {
      setIsFullscreen((estadoAnterior) => {
        const novoEstado = !estadoAnterior;
        
        if (novoEstado) {
          ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE);
          StatusBar.setHidden(true, 'fade');
        } else {
          ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
          StatusBar.setHidden(false, 'fade');
        }
        
        return novoEstado;
      });
    }
  };

  return (
    <SafeAreaView
      className="flex-1 bg-app-background"
      edges={isFullscreen ? [] : ["top", "bottom"]}
    >
      <View className="flex-1">
        
        {!isFullscreen && (
          <View className="flex-row items-center justify-between px-5 py-4">
            <TouchableOpacity
              className="rounded-full border border-app-secondary px-3 py-2"
              onPress={() => navigation.openDrawer()}
            >
              <Text className="text-xs font-semibold uppercase tracking-widest text-app-text">
                Menu
              </Text>
            </TouchableOpacity>
            <Text className="text-base font-semibold text-app-text">Viewer</Text>
            <View className="w-12" />
          </View>
        )}

        <View className="flex-1 bg-[#0f172a] relative">

          {state.hubUrl ? (
            <WebView
              source={{ uri: state.hubUrl }}
              className="flex-1"
              onMessage={handleWebViewMessage}
              allowsFullscreenVideo={true}
              scalesPageToFit={true}
              javaScriptEnabled={true} // <-- Adicionado por segurança
            />
          ) : (
            <View className="flex-1 items-center justify-center">
              <ActivityIndicator color="#ff914d" />
              <Text className="mt-3 text-sm text-app-muted">
                Aguardando transmissão...
              </Text>
              <Text className="mt-2 text-xs text-app-muted">
                {connectionLabel} {state.hubIp ? `- Hub: ${state.hubIp}` : ""}
              </Text>
            </View>
          )}
        </View>
      </View>
    </SafeAreaView>
  );
};

export default ViewerScreen;