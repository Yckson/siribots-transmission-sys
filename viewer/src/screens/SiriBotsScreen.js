import React, { useMemo } from "react";
import { Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";

const DEFAULT_URL = "https://siribots.vercel.app/#sobre";

const SiriBotsScreen = ({ navigation, route }) => {
  const { url, title } = route?.params || {};
  const resolvedUrl = useMemo(() => url || DEFAULT_URL, [url]);
  const resolvedTitle = title || "SiriBots";

  return (
    <SafeAreaView
      className="flex-1 bg-app-background"
      edges={["top", "bottom"]}
    >
      <View className="flex-row items-center justify-between px-5 py-4">
        <TouchableOpacity
          className="rounded-full border border-app-secondary px-3 py-2"
          onPress={() => navigation.openDrawer()}
        >
          <Text className="text-xs font-semibold uppercase tracking-widest text-app-text">
            Menu
          </Text>
        </TouchableOpacity>
        <Text className="text-base font-semibold text-app-text">
          {resolvedTitle}
        </Text>
        <View className="w-12" />
      </View>

      <View className="flex-1">
        <WebView source={{ uri: resolvedUrl }} className="flex-1" />
      </View>
    </SafeAreaView>
  );
};

export default SiriBotsScreen;
