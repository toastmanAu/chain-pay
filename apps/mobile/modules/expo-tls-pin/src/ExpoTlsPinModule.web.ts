import type { PinnedRequestArgs, PinnedRequestResult } from "./ExpoTlsPinModule";

const ExpoTlsPinWeb = {
  async request(_args: PinnedRequestArgs): Promise<PinnedRequestResult> {
    return {
      ok: false,
      kind: "network",
      detail: "expo-tls-pin is not supported on web",
    };
  },
};

export default ExpoTlsPinWeb;
