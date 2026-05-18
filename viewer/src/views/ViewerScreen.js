import React from "react";
import { ActivityIndicator, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Video, ResizeMode, VideoFullscreenUpdate } from "expo-av";
import * as ScreenOrientation from "expo-screen-orientation";

const ViewerScreen = ({ state, navigation }) => {
  const connectionLabel = state.isLive ? "Ao vivo" : "Aguardando";

  const handleFullscreenUpdate = async ({ fullscreenUpdate }) => {
    if (fullscreenUpdate === VideoFullscreenUpdate.PLAYER_WILL_PRESENT) {
      await ScreenOrientation.unlockAsync();
    }

    if (fullscreenUpdate === VideoFullscreenUpdate.PLAYER_WILL_DISMISS) {
      await ScreenOrientation.lockAsync(
        ScreenOrientation.OrientationLock.PORTRAIT_UP
      );
    }
  };

  return (
    <SafeAreaView
      className="flex-1 bg-app-background"
      edges={["top", "bottom"]}
    >
      <View className="flex-1 px-5 pt-4 pb-6">
        <View className="mb-6 flex-row items-center justify-between">
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

        <View className="flex-1">
        <Text className="text-2xl font-bold tracking-wide text-app-text">
          Siribots Viewer
        </Text>

        <View className="mt-4 flex-row items-center space-x-3">
          <View
            className={`rounded-full px-3 py-1 ${
              state.isLive ? "bg-app-primary" : "bg-app-accent"
            }`}
          >
            <Text className="text-xs font-bold text-app-background">
              {connectionLabel}
            </Text>
          </View>
          {state.hubIp ? (
            <Text className="text-xs text-app-muted">Hub: {state.hubIp}</Text>
          ) : null}
        </View>

        <Text className="mt-3 text-sm text-app-text">{state.status}</Text>

        <View
          className="mt-6 w-full overflow-hidden rounded-2xl bg-[#0f172a]"
          style={{ aspectRatio: 16 / 9 }}
        >
          {state.showVideo && state.hlsUrl ? (
            <Video
              source={{
                uri: state.hlsUrl,
                overrideFileExtensionAndroid: "m3u8",
              }}
              style={{ flex: 1 }}
              resizeMode={ResizeMode.CONTAIN}
              shouldPlay
              isMuted={false}
              useNativeControls
              onFullscreenUpdate={handleFullscreenUpdate}
            />
          ) : (
            <View className="flex-1 items-center justify-center">
              <ActivityIndicator color="#ff914d" />
              <Text className="mt-3 text-sm text-app-muted">
                Aguardando transmissao...
              </Text>
            </View>
          )}
        </View>

        <View className="mt-6 items-center">
          <Text className="text-xs uppercase tracking-[2px] text-app-muted">
            Conexao automatica ativa
          </Text>
        </View>
        </View>
      </View>
    </SafeAreaView>
  );
};

export default ViewerScreen;
