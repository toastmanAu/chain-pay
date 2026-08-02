import { describe, expect, it } from "vitest";
import {
  addDescriptorChecksum,
  deriveBitcoinReceiveAddress,
  descriptorChecksum,
  parseBitcoinWatchImport,
} from "./watch-source";

const BIP84_ACCOUNT_ZPUB =
  "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs";
const BIP86_ACCOUNT_XPUB =
  "xpub6BgBgsespWvERF3LHQu6CnqdvfEvtMcQjYrcRzx53QJjSxarj2afYWcLteoGVky7D3UKDP9QyrLprQ3VCECoY49yfdDEHGCtMMj92pReUsQ";
const BIP32_XPUB =
  "xpub6ERApfZwUNrhLCkDtcHTcxd75RbzS1ed54G1LkBUHQVHQKqhMkhgbmJbZRkrgZw4koxb5JaHWkY4ALHY2grBGRjaDMzQLcgJvLJuZZvRcEL";
const BIP32_XPRV =
  "xprvA1RpRA33e1JQ7ifknakTFpgNXPmW2YvmhqLQYMmrj4xJXXWYpDPS3xz7iAxn8L39njGVyuoseXzU6rcxFLJ8HFsTjSyQbLYnMpCqE2VbFWc";
const BIP49_TESTNET_ACCOUNT_UPUB =
  "upub5EFU65HtV5TeiSHmZZm7FUffBGy8UKeqp7vw43jYbvZPpoVsgU93oac7Wk3u6moKegAEWtGNF8DehrnHtv21XXEMYRUocHqguyjknFHYfgY";

describe("Bitcoin descriptor checksums", () => {
  it("matches the BIP-380 checksum vector", () => {
    expect(descriptorChecksum("raw(deadbeef)")).toBe("89f8spxm");
    expect(addDescriptorChecksum("raw(deadbeef)")).toBe("raw(deadbeef)#89f8spxm");
  });

  it("rejects a supplied checksum with any changed character", () => {
    const body = `wpkh(${BIP32_XPUB}/0/*)`;
    expect(() =>
      parseBitcoinWatchImport({
        kind: "descriptor",
        value: `${body}#aaaaaaaa`,
        chain: "btc:mainnet",
        scriptType: "p2wpkh",
      }),
    ).toThrow(/checksum/i);
  });
});

describe("Bitcoin watch imports", () => {
  it("normalizes and identifies standard mainnet and testnet addresses", () => {
    const mainnet = parseBitcoinWatchImport({
      kind: "address",
      value: "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu",
      chain: "btc:mainnet",
      scriptType: "p2wpkh",
    });
    expect(mainnet.source).toMatchObject({ kind: "address", scriptType: "p2wpkh" });

    expect(() =>
      parseBitcoinWatchImport({
        kind: "address",
        value: "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu",
        chain: "btc:testnet",
        scriptType: "p2wpkh",
      }),
    ).toThrow(/testnet/i);
    expect(() =>
      parseBitcoinWatchImport({
        kind: "address",
        value: "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu",
        chain: "btc:mainnet",
        scriptType: "p2tr",
      }),
    ).toThrow(/p2wpkh/i);
  });

  it("rejects private extended keys and mnemonic-like seed material", () => {
    expect(() =>
      parseBitcoinWatchImport({
        kind: "xpub",
        value: BIP32_XPRV,
        chain: "btc:mainnet",
        scriptType: "p2wpkh",
      }),
    ).toThrow(/private/i);
    expect(() =>
      parseBitcoinWatchImport({
        kind: "xpub",
        value: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
        chain: "btc:mainnet",
        scriptType: "p2wpkh",
      }),
    ).toThrow(/seed|mnemonic/i);
    expect(() =>
      parseBitcoinWatchImport({
        kind: "descriptor",
        value: "wpkh(L4rK1yDtCWekvXuE6oXD9jCYfFNV2cWRpVuPLBcCU2z8TrisoyY1)",
        chain: "btc:mainnet",
        scriptType: "p2wpkh",
      }),
    ).toThrow(/private/i);
  });

  it("rejects cross-network xpubs, hardened public suffixes, and script/version mismatches", () => {
    expect(() =>
      parseBitcoinWatchImport({
        kind: "xpub",
        value: BIP32_XPUB,
        chain: "btc:testnet",
        scriptType: "p2wpkh",
      }),
    ).toThrow(/mainnet/i);
    expect(() =>
      parseBitcoinWatchImport({
        kind: "descriptor",
        value: `wpkh(${BIP32_XPUB}/0h/*)`,
        chain: "btc:mainnet",
        scriptType: "p2wpkh",
      }),
    ).toThrow(/public extended key|wildcard/i);
    expect(() =>
      parseBitcoinWatchImport({
        kind: "xpub",
        value: BIP84_ACCOUNT_ZPUB,
        chain: "btc:mainnet",
        scriptType: "p2tr",
      }),
    ).toThrow(/implies p2wpkh/i);
  });

  it("canonicalizes a supported ranged descriptor and its key origin", () => {
    const body = `wpkh([deadbeef/84h/0h/0h]${BIP32_XPUB}/3/4/*)`;
    const config = parseBitcoinWatchImport({
      kind: "descriptor",
      value: body,
      chain: "btc:mainnet",
      scriptType: "p2wpkh",
      gapLimit: 30,
    });
    expect(config.gapLimit).toBe(30);
    expect(config.source).toMatchObject({
      kind: "descriptor",
      keyOrigin: "deadbeef/84h/0h/0h",
      derivationPath: [3, 4],
    });
    expect(config.source.kind === "descriptor" && config.source.descriptor).toBe(
      addDescriptorChecksum(body),
    );
  });
});

describe("public receive derivation", () => {
  it("matches the BIP-49 testnet nested-SegWit receive-address vector", () => {
    const config = parseBitcoinWatchImport({
      kind: "xpub",
      value: BIP49_TESTNET_ACCOUNT_UPUB,
      chain: "btc:testnet",
      scriptType: "p2sh-p2wpkh",
    });
    expect(deriveBitcoinReceiveAddress(config, 0)).toBe("2Mww8dCYPUpKHofjgcXcBCEGmniw9CoaiD2");
  });

  it("matches the first two BIP-84 P2WPKH receive-address vectors", () => {
    const config = parseBitcoinWatchImport({
      kind: "xpub",
      value: BIP84_ACCOUNT_ZPUB,
      chain: "btc:mainnet",
      scriptType: "p2wpkh",
    });
    expect(deriveBitcoinReceiveAddress(config, 0)).toBe(
      "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu",
    );
    expect(deriveBitcoinReceiveAddress(config, 1)).toBe(
      "bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g",
    );
  });

  it("matches the first two BIP-86 P2TR receive-address vectors", () => {
    const config = parseBitcoinWatchImport({
      kind: "xpub",
      value: BIP86_ACCOUNT_XPUB,
      chain: "btc:mainnet",
      scriptType: "p2tr",
    });
    expect(deriveBitcoinReceiveAddress(config, 0)).toBe(
      "bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr",
    );
    expect(deriveBitcoinReceiveAddress(config, 1)).toBe(
      "bc1p4qhjn9zdvkux4e44uhx8tc55attvtyu358kutcqkudyccelu0was9fqzwh",
    );
  });

  it("never permits hardened or out-of-range receive indexes", () => {
    const config = parseBitcoinWatchImport({
      kind: "xpub",
      value: BIP86_ACCOUNT_XPUB,
      chain: "btc:mainnet",
      scriptType: "p2tr",
    });
    expect(() => deriveBitcoinReceiveAddress(config, 0x80000000)).toThrow(/non-hardened/i);
    expect(() => deriveBitcoinReceiveAddress(config, -1)).toThrow(/non-hardened/i);
  });
});
