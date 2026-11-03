# Local wallet recovery boundary

The local BIP39 wallet is available only for the non-treasury CKB send path. Its encrypted vault and recovery words belong to Electron main. The renderer may send passwords and receives only the vault ID, public lock args, and operation status.

## Recovery flows

- **Create:** main generates the encrypted vault and displays the 12 words in a native dialog. It saves the vault after the dialog closes. The words do not enter renderer state or an IPC response.
- **Import:** the user copies 12 or 24 words and selects **Import from clipboard**. Main reads the system clipboard, clears it, and writes empty text. Main also asks the trusted app window to write an empty string because Electron 44.10.0 main-process clipboard writes can leave a previous Wayland clipboard owner active. Only the empty string reaches the renderer; the import IPC request contains only the password. The vault is created only after the clear steps succeed. Operating-system clipboard history may retain earlier copies; the UI warns about this.
- **Back up again:** after password verification, main displays the words in a native dialog and returns `{ ok: true }` over IPC.
- **Delete:** main verifies the vault password before removing the encrypted blob. Create and import refuse to replace an existing vault, including if another process wins the file creation race.

The native dialog and clipboard are operating-system surfaces. Keep the recovery words offline and away from screen capture or clipboard-history tools. The local wallet remains excluded from treasury and multisig signing.

## Verification

`keyvault-recovery-ipc.test.ts` exercises the real WASM package with temporary vault directories. It checks that create and export return no words, import rejects a renderer-supplied mnemonic, the clipboard clear steps finish before derivation and after invalid input, import fails closed if the window clear fails, existing vaults cannot be overwritten, and deletion requires the password. `keyvault-store.test.ts` covers exclusive file creation. The desktop test suite, typecheck, lint, production build, and packaged recovery smoke should be run before merging a change to these flows.

On 2026-11-03, a packaged Electron 44.10.0 app on GNOME Wayland imported the public BIP39 test vector copied from another Wayland process. A separate normal GTK entry window also copied that vector, and import succeeded after ChainPay regained focus. The vector was absent from Wayland and Xwayland clipboard reads afterward, while the disposable vault was deleted. An unfocused programmatic import refused to create a vault; the source phrase remained until manually cleared. Clipboard-manager history is outside ChainPay’s control.
