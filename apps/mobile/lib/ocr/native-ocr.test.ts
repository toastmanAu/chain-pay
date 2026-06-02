import { describe, it, expect, vi } from "vitest";
import { recognizeText } from "./native-ocr";

const mlkitMock = vi.fn();
vi.mock("@react-native-ml-kit/text-recognition", () => ({
  default: { recognize: (...a: unknown[]) => mlkitMock(...a) },
}));
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));

describe("native-ocr", () => {
  it("returns blocks + lines + full text from ML Kit on Android", async () => {
    mlkitMock.mockResolvedValue({
      text: "Acme Co\nINV-123\n$100.00",
      blocks: [
        { text: "Acme Co", lines: [{ text: "Acme Co", frame: { left: 0, top: 0, width: 50, height: 10 } }] },
        { text: "INV-123\n$100.00", lines: [
          { text: "INV-123", frame: { left: 0, top: 20, width: 50, height: 10 } },
          { text: "$100.00", frame: { left: 0, top: 35, width: 50, height: 10 } },
        ]},
      ],
    });
    const result = await recognizeText("/tmp/img.jpg");
    expect(result.fullText).toBe("Acme Co\nINV-123\n$100.00");
    expect(result.lines).toHaveLength(3);
    expect(result.lines[1]!.text).toBe("INV-123");
    expect(result.lines[1]!.box).toEqual({ x: 0, y: 20, w: 50, h: 10 });
  });

  it("returns empty on ML Kit throw", async () => {
    mlkitMock.mockRejectedValue(new Error("camera"));
    const result = await recognizeText("/tmp/x.jpg");
    expect(result.fullText).toBe("");
    expect(result.lines).toEqual([]);
  });
});
