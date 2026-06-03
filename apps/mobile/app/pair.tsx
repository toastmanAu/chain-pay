import { useState } from "react";
import { Alert, Button, StyleSheet, Text, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { router } from "expo-router";
import { parseFiberConnectUri } from "@chain-pay/shared";
import { usePairingStore } from "@/stores/pairing";
import { fetchCommPubkey, healthCheck } from "@/lib/transport/ip-client";

export default function PairScreen() {
  const [permission, requestPermission] = useCameraPermissions();
  const [busy, setBusy] = useState(false);
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
      <View style={styles.center}>
        <Text>Camera permission required to pair.</Text>
        <Button title="Grant permission" onPress={requestPermission} />
      </View>
    );
  }

  return (
    <View style={styles.full}>
      <CameraView style={styles.full} barcodeScannerSettings={{ barcodeTypes: ["qr"] }} onBarcodeScanned={onScan} />
      <Text style={styles.hint}>Point at the QR shown by ChainPay desktop</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  full: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 16 },
  hint: { position: "absolute", bottom: 24, alignSelf: "center", color: "white", backgroundColor: "rgba(0,0,0,0.5)", padding: 8, borderRadius: 6 },
});
