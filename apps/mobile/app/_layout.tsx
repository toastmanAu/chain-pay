import { Stack } from "expo-router";
import { SafeAreaProvider } from "react-native-safe-area-context";

export default function Layout() {
  return (
    <SafeAreaProvider>
      <Stack screenOptions={{ headerStyle: { backgroundColor: "#0f172a" }, headerTintColor: "#fff", headerTitleStyle: { fontWeight: "600" } }}>
        <Stack.Screen name="index" options={{ title: "ChainPay" }} />
        <Stack.Screen name="pair" options={{ title: "Pair Desktop" }} />
        <Stack.Screen name="capture" options={{ title: "Capture Invoice" }} />
        <Stack.Screen name="review" options={{ title: "Review" }} />
        <Stack.Screen name="settings" options={{ title: "Settings" }} />
      </Stack>
    </SafeAreaProvider>
  );
}
