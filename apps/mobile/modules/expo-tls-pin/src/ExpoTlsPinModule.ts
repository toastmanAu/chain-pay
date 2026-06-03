import { NativeModule, requireNativeModule } from "expo";

export type PinnedRequestArgs = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  fingerprint: string;
};

export type PinnedRequestResult =
  | {
      ok: true;
      status: number;
      headers: Record<string, string>;
      body: string;
    }
  | {
      ok: false;
      kind: "tls-mismatch" | "network";
      detail: string;
    };

declare class ExpoTlsPinModule extends NativeModule {
  request(args: PinnedRequestArgs): Promise<PinnedRequestResult>;
}

export default requireNativeModule<ExpoTlsPinModule>("ExpoTlsPin");
