import { useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { CameraView, useCameraPermissions } from "expo-camera";
import { File, Paths } from "expo-file-system";
import * as ImageManipulator from "expo-image-manipulator";
import { router } from "expo-router";
import { recognizeText } from "@/lib/ocr/native-ocr";
import { ocrToExtraction } from "@/lib/ocr/mapper";
import { useSyncQueue } from "@/stores/sync-queue";

const ZOOM_LEVELS: { label: string; value: number }[] = [
  { label: "1x", value: 0 },
  { label: "2x", value: 0.4 },
  { label: "3x", value: 0.7 },
];

export default function CaptureScreen() {
  const [permission, requestPermission] = useCameraPermissions();
  const cam = useRef<CameraView>(null);
  const [busy, setBusy] = useState(false);
  const [zoom, setZoom] = useState(0);
  const enqueue = useSyncQueue((s) => s.enqueue);

  const onShutter = async (): Promise<void> => {
    if (!cam.current || busy) return;
    setBusy(true);
    try {
      const shot = await cam.current.takePictureAsync({ quality: 0.85 });
      if (!shot) throw new Error("no photo");
      const resized = await ImageManipulator.manipulateAsync(
        shot.uri,
        [{ resize: { width: 2000 } }],
        { compress: 0.85, format: ImageManipulator.SaveFormat.JPEG },
      );
      const filename = `capture-${Date.now()}.jpg`;
      const src = new File(resized.uri);
      const dest = new File(Paths.cache, filename);
      src.move(dest);

      const ocr = await recognizeText(dest.uri);
      const extraction = ocrToExtraction(ocr.fullText);
      const id = enqueue({ capturedAt: Date.now(), imageRef: filename, extraction });
      router.push({ pathname: "/review", params: { id } });
    } finally {
      setBusy(false);
    }
  };

  if (!permission?.granted) {
    return (
      <SafeAreaView style={styles.center} edges={["top", "bottom"]}>
        <Text style={styles.permissionText}>Camera permission required to capture invoices.</Text>
        <Pressable onPress={requestPermission} style={({ pressed }) => [styles.primaryBtn, pressed && styles.pressed]}>
          <Text style={styles.primaryBtnLabel}>Grant permission</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  return (
    <View style={styles.full}>
      <CameraView ref={cam} style={styles.full} autofocus="on" zoom={zoom} />

      <View style={styles.zoomBar} pointerEvents="box-none">
        {ZOOM_LEVELS.map((level) => (
          <Pressable
            key={level.label}
            onPress={() => setZoom(level.value)}
            style={({ pressed }) => [
              styles.zoomChip,
              zoom === level.value && styles.zoomChipActive,
              pressed && styles.pressed,
            ]}
          >
            <Text style={[styles.zoomChipLabel, zoom === level.value && styles.zoomChipLabelActive]}>
              {level.label}
            </Text>
          </Pressable>
        ))}
      </View>

      <SafeAreaView edges={["bottom"]} style={styles.controlBar} pointerEvents="box-none">
        {busy ? (
          <View style={styles.shutterBusy}>
            <ActivityIndicator color="#fff" />
            <Text style={styles.shutterBusyLabel}>Processing…</Text>
          </View>
        ) : (
          <Pressable
            onPress={onShutter}
            style={({ pressed }) => [styles.shutter, pressed && styles.shutterPressed]}
            accessibilityLabel="Capture invoice"
          >
            <View style={styles.shutterInner} />
          </Pressable>
        )}
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  full: { flex: 1, backgroundColor: "#000" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 16, backgroundColor: "#f8fafc" },
  permissionText: { fontSize: 15, color: "#334155", textAlign: "center" },
  primaryBtn: { paddingHorizontal: 24, paddingVertical: 12, backgroundColor: "#2563eb", borderRadius: 10 },
  primaryBtnLabel: { color: "#fff", fontWeight: "600", fontSize: 15 },

  zoomBar: {
    position: "absolute",
    bottom: 140,
    alignSelf: "center",
    flexDirection: "row",
    gap: 8,
    backgroundColor: "rgba(0,0,0,0.45)",
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 999,
  },
  zoomChip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999 },
  zoomChipActive: { backgroundColor: "rgba(255,255,255,0.85)" },
  zoomChipLabel: { color: "#fff", fontWeight: "600", fontSize: 13 },
  zoomChipLabelActive: { color: "#0f172a" },

  controlBar: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    paddingBottom: 24,
    paddingTop: 24,
  },
  shutter: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: "rgba(255,255,255,0.25)",
    borderWidth: 4,
    borderColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
  },
  shutterPressed: { backgroundColor: "rgba(255,255,255,0.45)" },
  shutterInner: { width: 56, height: 56, borderRadius: 28, backgroundColor: "#fff" },
  shutterBusy: { alignItems: "center", gap: 8, paddingHorizontal: 18, paddingVertical: 14, backgroundColor: "rgba(0,0,0,0.6)", borderRadius: 12 },
  shutterBusyLabel: { color: "#fff", fontSize: 13 },
  pressed: { opacity: 0.7 },
});
