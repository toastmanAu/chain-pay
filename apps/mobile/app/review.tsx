import { useState } from "react";
import { useLocalSearchParams, router } from "expo-router";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
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
      <SafeAreaView style={styles.center} edges={["top", "bottom"]}>
        <Text style={styles.muted}>Queue item not found.</Text>
        <Pressable onPress={() => router.back()} style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}>
          <Text style={styles.secondaryLabel}>Back</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  const onQueue = (): void => {
    const parsedTotal = Number.parseFloat(totalStr);
    applyEdits(item.id, {
      invoice_number: invoiceNumber || undefined,
      total: Number.isFinite(parsedTotal) ? parsedTotal : undefined,
      currency: currency || undefined,
    });
    router.replace("/");
  };

  return (
    <SafeAreaView style={styles.root} edges={["bottom"]}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.heading}>Review extraction</Text>
        <Text style={styles.hint}>Confirm the OCR result before queueing for sync.</Text>

        <View style={styles.field}>
          <Text style={styles.label}>Invoice number</Text>
          <TextInput style={styles.input} value={invoiceNumber} onChangeText={setInvoiceNumber} autoCapitalize="characters" />
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>Total</Text>
          <TextInput style={styles.input} value={totalStr} onChangeText={setTotalStr} keyboardType="decimal-pad" />
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>Currency</Text>
          <TextInput style={styles.input} value={currency} onChangeText={setCurrency} autoCapitalize="characters" maxLength={3} />
        </View>

        <View style={styles.actions}>
          <Pressable onPress={() => router.replace("/")} style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}>
            <Text style={styles.secondaryLabel}>Discard</Text>
          </Pressable>
          <Pressable onPress={onQueue} style={({ pressed }) => [styles.primary, pressed && styles.pressed]}>
            <Text style={styles.primaryLabel}>Queue for sync</Text>
          </Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#f8fafc" },
  content: { padding: 16, gap: 14 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 12, backgroundColor: "#f8fafc" },
  heading: { fontSize: 20, fontWeight: "700", color: "#0f172a" },
  hint: { fontSize: 13, color: "#64748b", marginBottom: 4 },
  field: { gap: 4 },
  label: { fontSize: 13, color: "#475569", fontWeight: "500" },
  input: { borderWidth: 1, borderColor: "#cbd5f5", paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8, backgroundColor: "#fff", fontSize: 15 },
  actions: { flexDirection: "row", gap: 12, marginTop: 12 },
  primary: { flex: 1, paddingVertical: 14, borderRadius: 10, backgroundColor: "#2563eb", alignItems: "center" },
  primaryLabel: { color: "#fff", fontWeight: "600", fontSize: 15 },
  secondary: { flex: 1, paddingVertical: 14, borderRadius: 10, backgroundColor: "#fff", borderWidth: 1, borderColor: "#cbd5f5", alignItems: "center" },
  secondaryLabel: { color: "#1e3a8a", fontWeight: "600", fontSize: 15 },
  muted: { fontSize: 14, color: "#64748b" },
  pressed: { opacity: 0.7 },
});
