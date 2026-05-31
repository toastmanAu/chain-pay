# Phase 3c Smoke Playbook — Surya Backend

**Goal:** verify the Surya remote backend end-to-end against a live `surya-llama-server`.

## Setup

1. Pull `feat/phase-3c-surya-backend`, run `npm install`, then `npm run dev:desktop`.
2. Ensure your Surya server is running (`systemctl is-active surya-llama-server` on the host).
3. Have ready: a real PDF invoice, a photographed receipt, and the URL of your Surya endpoint (Phill: `http://192.168.68.134:9991/v1`).

## Cases

### 1. Configure backend
- Settings → Document extraction → switch to Remote (Surya).
- Enter your endpoint URL.
- Click [Test] → green pill within 1–2 s.
- Click [Save].

### 2. Real PDF — happy path
- New invoice → drop a real PDF.
- Within ~5 s fields populate.
- `line_items` table shows in the review form (Tesseract leaves these empty).
- `tax_total` populated if the document has GST/tax.
- Approve & queue.

### 3. Endpoint down
- Stop Surya on the server: `ssh phill@192.168.68.134 sudo systemctl stop surya-llama-server`.
- Drop another PDF.
- Failure banner shows: "Surya endpoint at 192.168.68.134:9991 unreachable. Check the server or switch backend in settings."
- Restart server: `ssh phill@192.168.68.134 sudo systemctl start surya-llama-server`.
- Click Retry → succeeds.

### 4. Misconfigured server
- Edit the unit and reset to `--parallel 8`: `sudo sed -i 's/--parallel 1/--parallel 8/' /etc/systemd/system/surya-llama-server.service && sudo systemctl daemon-reload && sudo systemctl restart surya-llama-server`.
- Drop a busy PDF.
- Failure banner shows: "Surya returned a truncated response — server may be misconfigured (check --parallel and --ctx-size)."
- Restore `--parallel 1`.

### 5. Back to Tesseract
- Settings → Document extraction → switch to Built-in (Tesseract.js) → Save.
- Drop a PDF.
- Phase 3b path runs unchanged: ~30 s, no line items, no tax.

### 6. Mid-session backend swap
- Drop a PDF with Surya selected.
- While reviewing, switch back to Tesseract in Settings.
- Drop a second PDF → verify it uses Tesseract (slower, no line items).
