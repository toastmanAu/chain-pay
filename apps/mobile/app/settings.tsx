import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import { usePairingStore } from "@/stores/pairing";

export default function SettingsScreen() {
  const pairing = usePairingStore((s) => s.pairing);
  const clearPairing = usePairingStore((s) => s.clearPairing);

  const onUnpair = (): void => {
    Alert.alert("Unpair desktop?", "You'll need to scan the desktop QR again to capture invoices.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Unpair",
        style: "destructive",
        onPress: () => {
          void clearPairing("user").then(() => router.replace("/"));
        },
      },
    ]);
  };

  return (
    <SafeAreaView style={styles.root} edges={["bottom"]}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.section}>Pairing</Text>

        {pairing ? (
          <View style={styles.card}>
            <Row label="Host" value={safeHost(pairing.rpc_url)} />
            <Row label="Cert fingerprint" value={truncateFingerprint(pairing.cert_fingerprint)} mono />
            <Pressable onPress={onUnpair} style={({ pressed }) => [styles.danger, pressed && styles.pressed]}>
              <Text style={styles.dangerLabel}>Unpair desktop</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.card}>
            <Text style={styles.muted}>No desktop paired.</Text>
            <Pressable onPress={() => router.push("/pair")} style={({ pressed }) => [styles.primary, pressed && styles.pressed]}>
              <Text style={styles.primaryLabel}>Pair desktop</Text>
            </Pressable>
          </View>
        )}

        <Text style={styles.section}>About</Text>
        <View style={styles.card}>
          <Row label="App" value="ChainPay Mobile" />
          <Row label="Build" value="0.1.0 dev" />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, mono && styles.mono]} numberOfLines={2}>{value}</Text>
    </View>
  );
}

function safeHost(rpcUrl: string): string {
  try {
    return new URL(rpcUrl).host;
  } catch {
    return rpcUrl;
  }
}

function truncateFingerprint(fp: string): string {
  if (fp.length <= 23) return fp;
  return `${fp.slice(0, 11)}…${fp.slice(-11)}`;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#f8fafc" },
  content: { padding: 16, gap: 12 },
  section: { fontSize: 13, fontWeight: "600", color: "#64748b", textTransform: "uppercase", letterSpacing: 0.5, marginTop: 8 },
  card: { backgroundColor: "#fff", borderRadius: 12, borderWidth: 1, borderColor: "#e2e8f0", padding: 12, gap: 10 },
  row: { gap: 2 },
  rowLabel: { fontSize: 12, color: "#64748b" },
  rowValue: { fontSize: 14, color: "#0f172a" },
  mono: { fontFamily: "monospace" },
  muted: { fontSize: 14, color: "#64748b" },
  danger: { marginTop: 8, paddingVertical: 12, borderRadius: 10, backgroundColor: "#fee2e2", borderWidth: 1, borderColor: "#fecaca", alignItems: "center" },
  dangerLabel: { color: "#b91c1c", fontWeight: "600", fontSize: 15 },
  primary: { marginTop: 8, paddingVertical: 12, borderRadius: 10, backgroundColor: "#2563eb", alignItems: "center" },
  primaryLabel: { color: "#fff", fontWeight: "600", fontSize: 15 },
  pressed: { opacity: 0.7 },
});
