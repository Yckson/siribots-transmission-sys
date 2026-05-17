import React from "react";
import { Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

const ViewerScreen = ({ state, navigation }) => {
  const connectionLabel = state.connected ? "Conectado" : "Desconectado";

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

      <View className="flex-1 rounded-3xl border border-app-secondary bg-app-card p-6">
        <Text className="text-2xl font-bold tracking-wide text-app-text">
          Siribots Viewer
        </Text>

        <View className="mt-4 flex-row items-center space-x-3">
          <View
            className={`rounded-full px-3 py-1 ${
              state.connected ? "bg-app-primary" : "bg-app-accent"
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

        <View className="mt-6 h-56 items-center justify-center rounded-2xl border border-app-accent bg-[#0f172a]">
          <Text className="text-sm text-app-muted">Transmissao de video</Text>
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
