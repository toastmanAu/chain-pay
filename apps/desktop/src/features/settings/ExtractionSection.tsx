import { useState } from "react";
import { useExtractionSettingsStore, type ExtractionBackend } from "@/stores/extraction-settings";

const URL_SHAPE_RE = /^https?:\/\/[^/\s]+(\/v\d+)?$/;
const TEST_TIMEOUT_MS = 5000;

function healthUrlFor(apiUrl: string): string {
  return apiUrl.replace(/\/v\d+$/, "") + "/health";
}

function isUrlShapeValid(url: string): boolean {
  return URL_SHAPE_RE.test(url.trim());
}

export function ExtractionSection() {
  const backend = useExtractionSettingsStore((s) => s.extractionBackend);
  const url = useExtractionSettingsStore((s) => s.suryaEndpointUrl);
  const lastResult = useExtractionSettingsStore((s) => s.suryaLastTestResult);
  const lastAt = useExtractionSettingsStore((s) => s.suryaLastTestedAt);
  const setBackend = useExtractionSettingsStore((s) => s.setExtractionBackend);
  const setUrl = useExtractionSettingsStore((s) => s.setSuryaEndpointUrl);
  const recordTest = useExtractionSettingsStore((s) => s.recordSuryaTest);

  const [pendingBackend, setPendingBackend] = useState<ExtractionBackend>(backend);
  const [pendingUrl, setPendingUrl] = useState(url);
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);

  const isSurya = pendingBackend === "surya-remote";
  const urlValid = isUrlShapeValid(pendingUrl);
  const dirty = pendingBackend !== backend || pendingUrl !== url;
  const canTest = isSurya && urlValid && !testing;
  const canSave =
    pendingBackend === "tesseract" ||
    (isSurya && urlValid && lastResult === "ok");

  async function onTest() {
    if (!canTest) return;
    setTesting(true);
    setTestError(null);
    setUrl(pendingUrl);
    try {
      const resp = await fetch(healthUrlFor(pendingUrl), {
        signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
      });
      if (resp.ok) {
        recordTest("ok");
      } else {
        recordTest("bad-response");
        setTestError(`endpoint returned ${resp.status}`);
      }
    } catch (err) {
      recordTest("unreachable");
      setTestError(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  }

  function onSave() {
    if (!canSave) return;
    setBackend(pendingBackend);
  }

  function onCancel() {
    setPendingBackend(backend);
    setPendingUrl(url);
    setTestError(null);
  }

  return (
    <section className="space-y-3 rounded-lg border border-surface-hi bg-surface p-5">
      <header>
        <div className="text-xs uppercase tracking-wide text-fg-muted">Document extraction</div>
        <p className="mt-1 text-sm text-fg-muted">
          Choose which OCR backend handles uploaded invoices. Tesseract runs in the app
          and works offline; Surya runs on a remote server you control (better accuracy,
          extracts line items and tax totals).
        </p>
      </header>

      <fieldset className="space-y-1">
        <legend className="text-xs text-fg-muted">Backend</legend>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="extraction-backend"
            checked={pendingBackend === "tesseract"}
            onChange={() => setPendingBackend("tesseract")}
          />
          Built-in (Tesseract.js) — default, offline
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="extraction-backend"
            checked={pendingBackend === "surya-remote"}
            onChange={() => setPendingBackend("surya-remote")}
          />
          Remote (Surya) — better accuracy, needs server
        </label>
      </fieldset>

      <label className="block">
        <span className="text-xs text-fg-muted">Surya endpoint URL</span>
        <div className="mt-1 flex gap-2">
          <input
            type="text"
            value={pendingUrl}
            onChange={(e) => setPendingUrl(e.target.value)}
            disabled={!isSurya}
            aria-label="Surya endpoint URL"
            className="flex-1 rounded border px-2 py-1 text-sm disabled:opacity-50"
          />
          <button
            type="button"
            disabled={!canTest}
            onClick={onTest}
            className="rounded border px-3 py-1 text-sm disabled:opacity-50"
          >
            {testing ? "Testing…" : "Test"}
          </button>
        </div>
      </label>

      {isSurya && lastResult === "ok" && (
        <p className="text-xs text-green-600">✓ Reachable · last tested {lastAt}</p>
      )}
      {isSurya && lastResult === "unreachable" && (
        <p className="text-xs text-red-600">✗ Unreachable: {testError ?? "network error"}</p>
      )}
      {isSurya && lastResult === "bad-response" && (
        <p className="text-xs text-red-600">✗ Endpoint responded but didn't look like Surya: {testError}</p>
      )}

      <div className="flex gap-2 pt-2">
        <button
          type="button"
          disabled={!canSave}
          onClick={onSave}
          className="rounded bg-blue-600 px-3 py-1 text-sm text-white disabled:opacity-50"
        >
          Save
        </button>
        <button
          type="button"
          disabled={!dirty}
          onClick={onCancel}
          className="rounded border px-3 py-1 text-sm disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </section>
  );
}
