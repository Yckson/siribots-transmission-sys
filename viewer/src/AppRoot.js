import React, { useEffect } from "react";
import { InteractionManager } from "react-native";
import { NavigationContainer } from "@react-navigation/native";
import { createDrawerNavigator } from "@react-navigation/drawer";
import useStreamController from "./controllers/StreamController";
import ViewerScreen from "./views/ViewerScreen";
import SiriBotsScreen from "./screens/SiriBotsScreen";
import AppDrawerContent from "./navigation/AppDrawerContent";

const Drawer = createDrawerNavigator();

const AppRoot = () => {
  const { state, startDiscovery } = useStreamController();

  useEffect(() => {
    const task = InteractionManager.runAfterInteractions(() => {
      startDiscovery();
    });

    return () => {
      if (task?.cancel) task.cancel();
    };
  }, [startDiscovery]);

  return (
    <NavigationContainer>
      <Drawer.Navigator
        screenOptions={{
          headerShown: false,
          drawerStyle: { backgroundColor: "#0b1a2e", width: 280 },
          overlayColor: "rgba(2,14,29,0.6)",
          sceneContainerStyle: { backgroundColor: "#020e1d" },
        }}
        drawerContent={(props) => <AppDrawerContent {...props} />}
      >
        <Drawer.Screen name="Viewer">
          {(props) => <ViewerScreen {...props} state={state} />}
        </Drawer.Screen>
        <Drawer.Screen name="SiriBots" component={SiriBotsScreen} />
      </Drawer.Navigator>
    </NavigationContainer>
  );
};

export default AppRoot;
