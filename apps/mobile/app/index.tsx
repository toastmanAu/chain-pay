import { useEffect } from "react";
import { Button, FlatList, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { usePairingStore } from "@/stores/pairing";
import { useSyncQueue } from "@/stores/sync-queue";
import { useDrainQueue } from "@/lib/useDrainQueue";

export default function Home() {
  const pairing = usePairingStore((s) => s.pairing);
  const loadPairing = usePairingStore((s) => s.loadPairing);
  const items = useSyncQueue((s) => s.items);

  useEffect(() => {
    void loadPairing();
  }, [loadPairing]);
  useDrainQueue();

  if (!pairing) {
    return (
      <View style={styles.center}>
        <Text style={styles.title}>ChainPay Mobile</Text>
        <Text>No desktop paired.</Text>
        <Button title="Pair desktop" onPress={() => router.push("/pair")} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Queue</Text>
      <FlatList
        data={items}
        keyExtractor={(i) => i.id}
        renderItem={({ item }) => (
          <View style={styles.row}>
            <Text>
              {(item.extraction.body as { invoice_number?: string }).invoice_number ?? "(no number)"}
            </Text>
            <Text style={styles.status}>{item.status}</Text>
          </View>
        )}
        ListEmptyComponent={<Text>No captures yet.</Text>}
      />
      <Button title="Capture invoice" onPress={() => router.push("/capture")} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, gap: 12 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 16 },
  title: { fontSize: 22, fontWeight: "700" },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    padding: 8,
    borderBottomWidth: 1,
    borderColor: "#eee",
  },
  status: { color: "#666" },
});
