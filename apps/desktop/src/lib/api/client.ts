/**
 * Frappe REST client. Wired up in Phase 4.
 * Currently a placeholder so feature code can import a stable surface.
 */
export interface FrappeClientOptions {
  baseUrl: string;
  apiKey?: string;
  apiSecret?: string;
}

export class FrappeClient {
  constructor(private opts: FrappeClientOptions) {}

  async call<T>(method: string, args?: Record<string, unknown>): Promise<T> {
    void this.opts;
    void method;
    void args;
    throw new Error("FrappeClient not yet wired — Phase 4");
  }
}

export const frappe = new FrappeClient({
  baseUrl: import.meta.env.VITE_FRAPPE_BASE_URL ?? "http://localhost:8000",
});
