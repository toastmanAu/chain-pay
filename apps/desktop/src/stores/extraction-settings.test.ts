import { beforeEach, describe, expect, it } from "vitest";
import { useExtractionSettingsStore } from "./extraction-settings";

describe("useExtractionSettingsStore", () => {
  beforeEach(() => {
    useExtractionSettingsStore.setState({
      extractionBackend: "tesseract",
      suryaEndpointUrl: "http://localhost:9991/v1",
      suryaLastTestedAt: undefined,
      suryaLastTestResult: undefined,
    });
  });

  it("defaults to tesseract backend and localhost URL", () => {
    const s = useExtractionSettingsStore.getState();
    expect(s.extractionBackend).toBe("tesseract");
    expect(s.suryaEndpointUrl).toBe("http://localhost:9991/v1");
    expect(s.suryaLastTestedAt).toBeUndefined();
    expect(s.suryaLastTestResult).toBeUndefined();
  });

  it("setExtractionBackend switches backend", () => {
    useExtractionSettingsStore.getState().setExtractionBackend("surya-remote");
    expect(useExtractionSettingsStore.getState().extractionBackend).toBe("surya-remote");
  });

  it("setSuryaEndpointUrl updates URL AND clears test state", () => {
    useExtractionSettingsStore.setState({
      extractionBackend: "surya-remote",
      suryaEndpointUrl: "http://localhost:9991/v1",
      suryaLastTestedAt: "2026-05-31T00:00:00Z",
      suryaLastTestResult: "ok",
    });
    useExtractionSettingsStore.getState().setSuryaEndpointUrl("http://192.168.68.134:9991/v1");
    const s = useExtractionSettingsStore.getState();
    expect(s.suryaEndpointUrl).toBe("http://192.168.68.134:9991/v1");
    expect(s.suryaLastTestedAt).toBeUndefined();
    expect(s.suryaLastTestResult).toBeUndefined();
  });

  it("recordSuryaTest writes result + timestamp", () => {
    const before = Date.now();
    useExtractionSettingsStore.getState().recordSuryaTest("ok");
    const s = useExtractionSettingsStore.getState();
    expect(s.suryaLastTestResult).toBe("ok");
    expect(s.suryaLastTestedAt).toBeDefined();
    expect(new Date(s.suryaLastTestedAt!).getTime()).toBeGreaterThanOrEqual(before);
  });
});
