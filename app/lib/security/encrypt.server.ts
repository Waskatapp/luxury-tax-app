// TODO(phase-10): replace with AES-256-GCM using ENCRYPTION_KEY env var.
// Identity stubs for now so call sites stay stable.
// See CLAUDE.md section 15 and Rule #6.

export function encrypt(plain: string): string {
  return plain;
}

export function decrypt(cipher: string): string {
  return cipher;
}
