import { useEffect, useRef, useState } from "react";

interface AutoBroadcastCountdownProps {
  onElapsed: () => void;
  onCancel: () => void;
  initialSeconds?: number;
}

export function AutoBroadcastCountdown({
  onElapsed,
  onCancel,
  initialSeconds = 5,
}: AutoBroadcastCountdownProps) {
  const [secondsLeft, setSecondsLeft] = useState(initialSeconds);
  const [isCancelled, setIsCancelled] = useState(false);
  const firedRef = useRef(false);

  // Countdown effect
  useEffect(() => {
    if (isCancelled) return;

    if (secondsLeft <= 0) {
      if (!firedRef.current) {
        firedRef.current = true;
        onElapsed();
      }
      return;
    }

    const timer = setTimeout(() => {
      setSecondsLeft((prev) => prev - 1);
    }, 1000);

    return () => clearTimeout(timer);
  }, [secondsLeft, isCancelled, onElapsed]);

  const handleCancel = () => {
    setIsCancelled(true);
    onCancel();
  };

  return (
    <div className="rounded border border-amber-700 bg-amber-950/40 p-3 text-sm flex items-center justify-between">
      <div>
        <strong>Broadcasting in {secondsLeft}…</strong>
        <p className="text-xs text-neutral-400">
          M sigs collected — auto-broadcast will fire shortly.
        </p>
      </div>
      <button
        type="button"
        onClick={handleCancel}
        className="px-3 py-1 rounded border border-neutral-600 hover:bg-neutral-800 text-sm"
      >
        Cancel
      </button>
    </div>
  );
}
