import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetEncryptionKeyCacheForTesting,
  decrypt,
  encrypt,
} from "../../../app/lib/security/encrypt.server";

const TEST_KEY_HEX = "0".repeat(64); // 32 bytes of zeros, hex-encoded

describe("encrypt / decrypt", () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = TEST_KEY_HEX;
    _resetEncryptionKeyCacheForTesting();
  });

  afterEach(() => {
    delete process.env.ENCRYPTION_KEY;
    _resetEncryptionKeyCacheForTesting();
    vi.restoreAllMocks();
  });

  it("round-trips plaintext through v1 ciphertext", () => {
    const plain = "shpat_abcdef0123456789";
    const ct = encrypt(plain);
    expect(ct.startsWith("v1:")).toBe(true);
    expect(ct).not.toContain(plain);
    expect(decrypt(ct)).toBe(plain);
  });

  it("produces a different ciphertext on each call (random IV)", () => {
    const a = encrypt("same");
    const b = encrypt("same");
    expect(a).not.toBe(b);
    expect(decrypt(a)).toBe("same");
    expect(decrypt(b)).toBe("same");
  });

  it("returns empty string unchanged (token-not-set sentinel)", () => {
    expect(encrypt("")).toBe("");
    expect(decrypt("")).toBe("");
  });

  it("decrypt falls back on legacy unversioned plaintext (and warns once)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(decrypt("shpat_legacy_plaintext_token")).toBe("shpat_legacy_plaintext_token");
    expect(decrypt("shpat_other_legacy")).toBe("shpat_other_legacy");
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed v1 ciphertext", () => {
    expect(() => decrypt("v1:notenoughparts")).toThrow(/malformed/);
  });

  it("rejects tampered ciphertext (GCM auth tag check)", () => {
    const ct = encrypt("secret");
    const parts = ct.split(":");
    const ctBytes = Buffer.from(parts[3], "base64");
    ctBytes[0] = ctBytes[0] ^ 0xff; // flip a byte
    const tampered = `${parts[0]}:${parts[1]}:${parts[2]}:${ctBytes.toString("base64")}`;
    expect(() => decrypt(tampered)).toThrow();
  });

  it("rejects bad-length ENCRYPTION_KEY at first use", () => {
    process.env.ENCRYPTION_KEY = "deadbeef"; // 4 bytes, not 32
    _resetEncryptionKeyCacheForTesting();
    expect(() => encrypt("anything")).toThrow(/ENCRYPTION_KEY must be 32 bytes/);
  });
});
