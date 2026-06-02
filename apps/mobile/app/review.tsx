import { useState } from "react";
import { useLocalSearchParams, router } from "expo-router";
import { Button, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSyncQueue } from "@/stores/sync-queue";

export default function ReviewScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const item = useSyncQueue((s) => (params.id ? s.findById(params.id) : undefined));
  const applyEdits = useSyncQueue((s) => s.applyEdits);

  const body = item?.extraction.body as { invoice_number?: string; total?: number; currency?: string } | undefined;
  const [invoiceNumber, setInvoiceNumber] = useState(body?.invoice_number ?? "");
  const [totalStr, setTotalStr] = useState(body?.total?.toString() ?? "");
  const [currency, setCurrency] = useState(body?.currency ?? "");

  if (!item) {
    return (
      <View style={styles.center}>
        <Text>Queue item not found.</Text>
        <Button title="Back" onPress={() => router.back()} />
      </View>
    );
  }

  const onQueue = () => {
    const parsedTotal = Number.parseFloat(totalStr);
    applyEdits(item.id, {
      invoice_number: invoiceNumber || undefined,
      total: Number.isFinite(parsedTotal) ? parsedTotal : undefined,
      currency: currency || undefined,
    });
    router.replace("/");
  };

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.heading}>Review extraction</Text>
      <Text style={styles.label}>Invoice number</Text>
      <TextInput style={styles.input} value={invoiceNumber} onChangeText={setInvoiceNumber} />
      <Text style={styles.label}>Total</Text>
      <TextInput style={styles.input} value={totalStr} onChangeText={setTotalStr} keyboardType="decimal-pad" />
      <Text style={styles.label}>Currency</Text>
      <TextInput style={styles.input} value={currency} onChangeText={setCurrency} autoCapitalize="characters" maxLength={3} />
      <View style={styles.row}>
        <Button title="Discard" onPress={() => router.replace("/")} />
        <Button title="Queue for sync" onPress={onQueue} />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, gap: 12 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  heading: { fontSize: 18, fontWeight: "600" },
  label: { fontSize: 14, color: "#444" },
  input: { borderWidth: 1, borderColor: "#ccc", padding: 8, borderRadius: 4 },
  row: { flexDirection: "row", justifyContent: "space-between", marginTop: 16 },
});
