import { useState } from "react";
import { Alert, Button, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { CameraView, useCameraPermissions } from "expo-camera";
import { router } from "expo-router";
import { parseFiberConnectUri } from "@chain-pay/shared";
import { usePairingStore } from "@/stores/pairing";
import { fetchCommPubkey, healthCheck } from "@/lib/transport/ip-client";

export default function PairScreen() {
  const [permission, requestPermission] = useCameraPermissions();
  const [busy, setBusy] = useState(false);
  const [zoomStep, setZoomStep] = useState(0);
  const savePairing = usePairingStore((s) => s.savePairing);

  const onScan = async ({ data }: { data: string }) => {
    if (busy) return;
    setBusy(true);
    try {
      const parsed = parseFiberConnectUri(data);
      if (!parsed.cert_fingerprint || parsed.cert_fingerprint.trim() === "") {
        Alert.alert("Invalid QR", "Pairing QR is missing the TLS certificate fingerprint.");
        setBusy(false);
        return;
      }
      const pairing = {
        rpc_url: parsed.rpc_url,
        auth_token: parsed.auth_token,
        cert_fingerprint: parsed.cert_fingerprint,
        desktop_comm_pubkey: "0x" + "00".repeat(32),
      };
      const healthy = await healthCheck(pairing);
      if (!healthy) {
        Alert.alert("Cannot reach desktop", "Make sure desktop ChainPay is running on this network, or that the certificate matches this pairing code.");
        setBusy(false);
        return;
      }
      const commPubkey = await fetchCommPubkey(pairing);
      await savePairing({ ...pairing, desktop_comm_pubkey: commPubkey ?? pairing.desktop_comm_pubkey });
      router.replace("/");
    } catch (e) {
      Alert.alert("Invalid QR", e instanceof Error ? e.message : "could not parse");
      setBusy(false);
    }
  };

  if (!permission?.granted) {
    return (
      <SafeAreaView style={styles.center} edges={["top", "bottom"]}>
        <Text>Camera permission required to pair.</Text>
        <Button title="Grant permission" onPress={requestPermission} />
      </SafeAreaView>
    );
  }

  return (
    <View style={styles.full}>
      <CameraView
        style={styles.full}
        zoom={zoomStep / 10}
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={onScan}
      />
      <SafeAreaView edges={["bottom"]} style={styles.controls} pointerEvents="box-none">
        <View style={styles.zoomBar}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Zoom out"
            disabled={zoomStep === 0}
            onPress={() => setZoomStep((value) => Math.max(0, value - 1))}
            style={({ pressed }) => [
              styles.zoomButton,
              zoomStep === 0 && styles.zoomButtonDisabled,
              pressed && styles.zoomButtonPressed,
            ]}
          >
            <Text style={styles.zoomButtonLabel}>−</Text>
          </Pressable>
          <Text style={styles.zoomLabel} accessibilityLiveRegion="polite">Zoom {zoomStep * 10}%</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Zoom in"
            disabled={zoomStep === 10}
            onPress={() => setZoomStep((value) => Math.min(10, value + 1))}
            style={({ pressed }) => [
              styles.zoomButton,
              zoomStep === 10 && styles.zoomButtonDisabled,
              pressed && styles.zoomButtonPressed,
            ]}
          >
            <Text style={styles.zoomButtonLabel}>+</Text>
          </Pressable>
        </View>
        <Text style={styles.hint}>Point at the QR shown by ChainPay desktop</Text>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  full: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 16 },
  controls: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    gap: 12,
    paddingBottom: 24,
  },
  zoomBar: {
    flexDirection: "row", alignItems: "center", gap: 12, padding: 8,
    borderRadius: 12, backgroundColor: "rgba(0,0,0,0.65)",
  },
  zoomButton: {
    width: 48, height: 48, borderRadius: 8, alignItems: "center",
    justifyContent: "center", backgroundColor: "rgba(255,255,255,0.2)",
  },
  zoomButtonDisabled: { opacity: 0.4 },
  zoomButtonPressed: { opacity: 0.7 },
  zoomButtonLabel: { color: "white", fontSize: 24, fontWeight: "600" },
  zoomLabel: { minWidth: 88, color: "white", fontSize: 14, fontWeight: "600", textAlign: "center" },
  hint: { color: "white", backgroundColor: "rgba(0,0,0,0.5)", padding: 8, borderRadius: 6 },
});
