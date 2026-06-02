import { useRef, useState } from "react";
import { ActivityIndicator, Button, StyleSheet, Text, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { File, Paths } from "expo-file-system";
import * as ImageManipulator from "expo-image-manipulator";
import { router } from "expo-router";
import { recognizeText } from "@/lib/ocr/native-ocr";
import { ocrToExtraction } from "@/lib/ocr/mapper";
import { useSyncQueue } from "@/stores/sync-queue";

export default function CaptureScreen() {
  const [permission, requestPermission] = useCameraPermissions();
  const cam = useRef<CameraView>(null);
  const [busy, setBusy] = useState(false);
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
      <View style={styles.center}>
        <Text>Camera permission required.</Text>
        <Button title="Grant permission" onPress={requestPermission} />
      </View>
    );
  }

  return (
    <View style={styles.full}>
      <CameraView ref={cam} style={styles.full} />
      <View style={styles.bar}>
        {busy ? <ActivityIndicator /> : <Button title="Capture" onPress={onShutter} />}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  full: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 16 },
  bar: {
    position: "absolute",
    bottom: 24,
    alignSelf: "center",
    backgroundColor: "white",
    padding: 12,
    borderRadius: 8,
  },
});
