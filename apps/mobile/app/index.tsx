import { useEffect } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import { usePairingStore } from "@/stores/pairing";
import { useSyncQueue } from "@/stores/sync-queue";
import { useDrainQueue } from "@/lib/useDrainQueue";

export default function Home() {
  const pairing = usePairingStore((s) => s.pairing);
  const wasAutoCleared = usePairingStore((s) => s.wasAutoCleared);
  const loadPairing = usePairingStore((s) => s.loadPairing);
  const items = useSyncQueue((s) => s.items);

  useEffect(() => {
    void loadPairing();
  }, [loadPairing]);
  useDrainQueue();

  const paired = pairing !== null;
  const pendingCount = items.filter((i) => i.status === "pending" || i.status === "pending-cellular").length;
  const desktopHost = pairing ? safeHost(pairing.rpc_url) : null;

  return (
    <SafeAreaView style={styles.root} edges={["bottom"]}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={[styles.statusCard, paired ? styles.statusOk : styles.statusWarn]}>
          <Text style={styles.statusBadge}>{paired ? "Connected" : wasAutoCleared ? "Re-pair required" : "Not paired"}</Text>
          <Text style={styles.statusDetail}>
            {paired ? desktopHost : wasAutoCleared ? "Desktop identity changed" : "Pair a desktop to start capturing"}
          </Text>
        </View>

        <Pressable
          onPress={() => router.push(paired ? "/capture" : "/pair")}
          style={({ pressed }) => [styles.primaryCta, !paired && styles.primaryCtaPair, pressed && styles.pressed]}
        >
          <Text style={styles.primaryCtaLabel}>{paired ? "Capture Invoice" : "Pair Desktop"}</Text>
          <Text style={styles.primaryCtaSub}>{paired ? "Scan an invoice with the camera" : "Scan the QR shown by ChainPay desktop"}</Text>
        </Pressable>

        <View style={styles.queueCard}>
          <Text style={styles.queueTitle}>Queue</Text>
          <Text style={styles.queueCount}>{pendingCount === 0 ? "No pending captures" : `${pendingCount} pending`}</Text>
          {items.length > 0 ? (
            <Text style={styles.queueTotal}>{items.length} total in queue</Text>
          ) : null}
        </View>

        <View style={styles.footerRow}>
          <Pressable onPress={() => router.push("/pair")} style={({ pressed }) => [styles.footerBtn, pressed && styles.pressed]}>
            <Text style={styles.footerBtnLabel}>Pair</Text>
          </Pressable>
          <Pressable onPress={() => router.push("/settings")} style={({ pressed }) => [styles.footerBtn, pressed && styles.pressed]}>
            <Text style={styles.footerBtnLabel}>Settings</Text>
          </Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function safeHost(rpcUrl: string): string {
  try {
    return new URL(rpcUrl).host;
  } catch {
    return rpcUrl;
  }
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#f8fafc" },
  content: { padding: 16, gap: 16 },
  statusCard: { padding: 16, borderRadius: 12, borderWidth: 1 },
  statusOk: { backgroundColor: "#ecfdf5", borderColor: "#a7f3d0" },
  statusWarn: { backgroundColor: "#fef3c7", borderColor: "#fcd34d" },
  statusBadge: { fontSize: 14, fontWeight: "700", color: "#0f172a" },
  statusDetail: { fontSize: 13, color: "#334155", marginTop: 4 },
  primaryCta: {
    backgroundColor: "#2563eb",
    paddingVertical: 28,
    paddingHorizontal: 20,
    borderRadius: 16,
    alignItems: "center",
  },
  primaryCtaPair: { backgroundColor: "#0f172a" },
  primaryCtaLabel: { color: "#fff", fontSize: 22, fontWeight: "700" },
  primaryCtaSub: { color: "#cbd5f5", fontSize: 13, marginTop: 6 },
  queueCard: {
    backgroundColor: "#fff",
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#e2e8f0",
  },
  queueTitle: { fontSize: 16, fontWeight: "600", color: "#0f172a" },
  queueCount: { fontSize: 14, color: "#475569", marginTop: 4 },
  queueTotal: { fontSize: 12, color: "#94a3b8", marginTop: 2 },
  footerRow: { flexDirection: "row", gap: 12, marginTop: 8 },
  footerBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 10,
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#cbd5f5",
    alignItems: "center",
  },
  footerBtnLabel: { fontSize: 15, fontWeight: "600", color: "#1e3a8a" },
  pressed: { opacity: 0.7 },
});
