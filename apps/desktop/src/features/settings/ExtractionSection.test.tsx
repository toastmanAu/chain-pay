// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { ExtractionSection } from "./ExtractionSection";
import { useExtractionSettingsStore } from "@/stores/extraction-settings";

const fetchMock = vi.fn();

describe("ExtractionSection", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    useExtractionSettingsStore.setState({
      extractionBackend: "tesseract",
      suryaEndpointUrl: "http://localhost:9991/v1",
      suryaLastTestedAt: undefined,
      suryaLastTestResult: undefined,
    });
  });

  it("renders both radio choices, defaulting to Tesseract selected", () => {
    render(<ExtractionSection />);
    const tess = screen.getByRole("radio", { name: /Built-in/i });
    const surya = screen.getByRole("radio", { name: /Remote/i });
    expect(tess).toBeChecked();
    expect(surya).not.toBeChecked();
  });

  it("URL field is disabled when Tesseract is selected", () => {
    render(<ExtractionSection />);
    const input = screen.getByLabelText(/Surya endpoint URL/i);
    expect(input).toBeDisabled();
  });

  it("URL field enables when Surya is picked", () => {
    render(<ExtractionSection />);
    fireEvent.click(screen.getByRole("radio", { name: /Remote/i }));
    expect(screen.getByLabelText(/Surya endpoint URL/i)).not.toBeDisabled();
  });

  it("Test button is disabled when URL shape is invalid", () => {
    useExtractionSettingsStore.setState({ extractionBackend: "surya-remote", suryaEndpointUrl: "not-a-url" });
    render(<ExtractionSection />);
    expect(screen.getByRole("button", { name: /Test/i })).toBeDisabled();
  });

  it("Test button calls /health, records 'ok' on 200", async () => {
    fetchMock.mockResolvedValue(new Response("OK", { status: 200 }));
    useExtractionSettingsStore.setState({ extractionBackend: "surya-remote", suryaEndpointUrl: "http://localhost:9991/v1" });
    render(<ExtractionSection />);
    fireEvent.click(screen.getByRole("button", { name: /Test/i }));
    await waitFor(() => {
      expect(useExtractionSettingsStore.getState().suryaLastTestResult).toBe("ok");
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:9991/health",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("Test button records 'unreachable' on fetch reject", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    useExtractionSettingsStore.setState({ extractionBackend: "surya-remote", suryaEndpointUrl: "http://localhost:9991/v1" });
    render(<ExtractionSection />);
    fireEvent.click(screen.getByRole("button", { name: /Test/i }));
    await waitFor(() => {
      expect(useExtractionSettingsStore.getState().suryaLastTestResult).toBe("unreachable");
    });
  });

  it("Save is disabled when Surya selected but never tested OK", () => {
    useExtractionSettingsStore.setState({ extractionBackend: "surya-remote", suryaLastTestResult: undefined });
    render(<ExtractionSection />);
    expect(screen.getByRole("button", { name: /Save/i })).toBeDisabled();
  });

  it("Save is enabled when Tesseract selected (no test required)", () => {
    render(<ExtractionSection />);
    expect(screen.getByRole("button", { name: /Save/i })).not.toBeDisabled();
  });

  it("Save re-enables for a fresh URL change after a successful test (regression for canSave deadlock)", async () => {
    // arrange: user is on surya-remote with one URL successfully tested
    fetchMock.mockResolvedValue(new Response("OK", { status: 200 }));
    useExtractionSettingsStore.setState({
      extractionBackend: "surya-remote",
      suryaEndpointUrl: "http://old:9991/v1",
      suryaLastTestResult: "ok",
      suryaLastTestedAt: "2026-05-31T00:00:00Z",
    });
    render(<ExtractionSection />);

    // act: type a new URL, click Test, wait for green
    const input = screen.getByLabelText(/Surya endpoint URL/i);
    fireEvent.change(input, { target: { value: "http://new:9991/v1" } });
    fireEvent.click(screen.getByRole("button", { name: /Test/i }));
    await waitFor(() => {
      expect(useExtractionSettingsStore.getState().suryaLastTestResult).toBe("ok");
    });

    // assert: Save is now enabled
    expect(screen.getByRole("button", { name: /Save/i })).not.toBeDisabled();
  });
});
