import { describe, expect, it } from "vitest";
import { createFiberConnectUri, parseFiberConnectUri } from "./fiberConnect";

describe("FiberConnect URI", () => {
  it("round-trips the protocol payload", () => {
    const uri = createFiberConnectUri({
      rpc_url: "https://node.example.com:8231",
      auth_token: "EsQCCtkBCghja",
      cert_fingerprint: "12:34:56",
    });

    expect(uri.startsWith("fiberconnect://")).toBe(true);
    expect(parseFiberConnectUri(uri)).toEqual({
      rpc_url: "https://node.example.com:8231/",
      auth_token: "EsQCCtkBCghja",
      cert_fingerprint: "12:34:56",
    });
  });

  it("omits empty certificate fingerprints", () => {
    expect(
      parseFiberConnectUri(
        createFiberConnectUri({
          rpc_url: "http://192.168.1.100:8231",
          auth_token: "token",
          cert_fingerprint: " ",
        }),
      ),
    ).toEqual({
      rpc_url: "http://192.168.1.100:8231/",
      auth_token: "token",
    });
  });

  it("rejects unsupported endpoint schemes", () => {
    expect(() =>
      createFiberConnectUri({
        rpc_url: "file:///tmp/node.sock",
        auth_token: "token",
      }),
    ).toThrow("http or https");
  });

  it("rejects URIs without the fiberconnect scheme", () => {
    expect(() => parseFiberConnectUri("http://x")).toThrow("must start with fiberconnect://");
  });

  it("rejects empty payloads", () => {
    expect(() => parseFiberConnectUri("fiberconnect://")).toThrow("payload is empty");
  });

  it("rejects parsed payloads missing rpc_url with the friendly error", () => {
    const json = JSON.stringify({ auth_token: "t" });
    const b64 = Buffer.from(json).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    expect(() => parseFiberConnectUri(`fiberconnect://${b64}`)).toThrow("FiberConnect rpc_url is required");
  });

  it("rejects parsed payloads where rpc_url is non-string", () => {
    const json = JSON.stringify({ rpc_url: 42, auth_token: "t" });
    const b64 = Buffer.from(json).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    expect(() => parseFiberConnectUri(`fiberconnect://${b64}`)).toThrow("FiberConnect rpc_url is required");
  });

  it("rejects parsed null payloads with the friendly error", () => {
    const b64 = Buffer.from("null").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    expect(() => parseFiberConnectUri(`fiberconnect://${b64}`)).toThrow("FiberConnect rpc_url is required");
  });
});
