import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { log } from "../log.server";

// AES-256-GCM at-rest encryption for Store.accessToken (CLAUDE.md §15, Rule #6).
//
// Format: "v1:<iv-b64>:<tag-b64>:<ciphertext-b64>" — version prefix lets us
// rotate to v2 without breaking existing rows. decrypt() falls back on
// unversioned strings (treats them as plaintext + warns once) so the dev
// store's existing plaintext token migrates naturally on its next admin
// request, since auth.server.ts re-runs encrypt() on every requireStoreAccess
// upsert.

const VERSION = "v1";
const ALGO = "aes-256-gcm";
const IV_BYTES = 12;
const KEY_BYTES = 32;

let cachedKey: Buffer | null = null;
let warnedOnPlaintextFallback = false;
let warnedOnMissingKey = false;

function loadKey(): Buffer {
  if (cachedKey) return cachedKey;
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex) {
    if (!warnedOnMissingKey) {
      log.warn(
        "ENCRYPTION_KEY not set — falling back to dev-only ephemeral key. Set ENCRYPTION_KEY in Railway before production.",
      );
      warnedOnMissingKey = true;
    }
    cachedKey = randomBytes(KEY_BYTES);
    return cachedKey;
  }
  const buf = Buffer.from(hex, "hex");
  if (buf.length !== KEY_BYTES) {
    throw new Error(
      `ENCRYPTION_KEY must be ${KEY_BYTES} bytes hex-encoded (${KEY_BYTES * 2} hex chars); got ${buf.length} bytes`,
    );
  }
  cachedKey = buf;
  return cachedKey;
}

export function encrypt(plain: string): string {
  if (plain === "") return "";
  const key = loadKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}:${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

export function decrypt(cipher: string): string {
  if (cipher === "") return "";
  if (!cipher.startsWith(`${VERSION}:`)) {
    if (!warnedOnPlaintextFallback) {
      log.warn(
        "decrypt() received unversioned ciphertext — treating as legacy plaintext. Will be migrated on next encrypt().",
      );
      warnedOnPlaintextFallback = true;
    }
    return cipher;
  }
  const parts = cipher.split(":");
  if (parts.length !== 4) {
    throw new Error("decrypt: malformed ciphertext (expected v1:iv:tag:ct)");
  }
  const [, ivB64, tagB64, ctB64] = parts;
  const key = loadKey();
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const ct = Buffer.from(ctB64, "base64");
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf8");
}

// Test seam: lets the unit test reset the cached key between cases without
// polluting process state.
export function _resetEncryptionKeyCacheForTesting(): void {
  cachedKey = null;
  warnedOnPlaintextFallback = false;
  warnedOnMissingKey = false;
}
