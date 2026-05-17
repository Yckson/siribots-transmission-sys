import React from "react";
import { DrawerContentScrollView } from "@react-navigation/drawer";
import { Text, TouchableOpacity, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { IEEE_MEMBERSHIP_LINK, SIRIBOTS_LINKS } from "../config/siribotsLinks";

const DrawerItem = ({ label, onPress, isPrimary, className }) => {
  const baseClass = "rounded-xl px-4 py-3";
  const styleClass = isPrimary
    ? "bg-app-primary"
    : "border border-app-secondary";
  const textClass = isPrimary
    ? "text-app-background font-bold"
    : "text-app-text";

  return (
    <TouchableOpacity
      className={`${baseClass} ${styleClass} ${className || ""}`}
      style={{ minHeight: 44 }}
      onPress={onPress}
    >
      <Text className={`${textClass} text-sm leading-5`}>{label}</Text>
    </TouchableOpacity>
  );
};

const AppDrawerContent = (props) => {
  const { navigation } = props;
  const insets = useSafeAreaInsets();

  const navigateToViewer = () => {
    navigation.navigate("Viewer");
    navigation.closeDrawer();
  };

  const openSiriBots = (link) => {
    navigation.navigate("SiriBots", { url: link.url, title: link.label });
    navigation.closeDrawer();
  };

  return (
    <DrawerContentScrollView
      {...props}
      contentContainerStyle={{ paddingTop: insets.top + 16, paddingBottom: 24 }}
      style={{ backgroundColor: "#0b1a2e" }}
    >
      <View style={{ gap: 16 }} className="px-5 pt-6">
        <Text className="text-xs uppercase tracking-[3px] text-app-muted">
          SiriBots
        </Text>
        <Text className="mt-2 text-2xl font-bold text-app-text">
          Transmission Hub
        </Text>
      </View>

      <View style={{ gap: 12 }} className="mt-6 px-5">
        <DrawerItem label="Viewer" onPress={navigateToViewer} />
      </View>

      <View className="mt-8 px-5">
        <Text className="text-xs uppercase tracking-[3px] text-app-muted">
          SiriBots Links
        </Text>
      </View>

      <View style={{ gap: 12 }} className="mt-4 px-5">
        {SIRIBOTS_LINKS.map((link) => (
          <DrawerItem
            key={link.label}
            label={link.label}
            onPress={() => openSiriBots(link)}
          />
        ))}
      </View>

      <View className="mt-2 px-5">
        <DrawerItem
          label={IEEE_MEMBERSHIP_LINK.label}
          onPress={() => openSiriBots(IEEE_MEMBERSHIP_LINK)}
          isPrimary
        />
      </View>
    </DrawerContentScrollView>
  );
};

export default AppDrawerContent;
