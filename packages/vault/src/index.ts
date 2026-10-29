import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Envelope encryption for provider credentials (API keys, OAuth tokens).
 *
 * Each secret is encrypted with its own random data key (DEK) using AES-256-GCM. The DEK is then
 * encrypted ("wrapped") with the master key (KEK). Only the wrapped DEK is stored, so rotating the
 * master key means re-wrapping small DEKs, not re-encrypting every secret.
 *
 * Uses only node:crypto, so there is nothing native to install on Windows, macOS or Linux.
 */

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export type SealedSecret = {
  /** Secret encrypted with the DEK: iv | ciphertext | auth tag. */
  ciphertext: Buffer;
  /** DEK encrypted with the master key: iv | ciphertext | auth tag. */
  wrappedDek: Buffer;
  /** Identifies which master key wrapped the DEK, for rotation. */
  kekId: string;
  /** Last characters of the secret, safe to show in the UI. */
  hint: string;
};

export type MasterKey = { id: string; key: Buffer };

export class VaultError extends Error {
  override name = "VaultError";
}

/** Creates a new random master key, encoded as base64 for INFUTURE_MASTER_KEY. */
export function generateMasterKey(): string {
  return randomBytes(KEY_BYTES).toString("base64");
}

/** Parses a base64 master key. The id is derived from the key so it never needs to be stored separately. */
export function loadMasterKey(encoded: string | undefined): MasterKey {
  if (!encoded) {
    throw new VaultError("INFUTURE_MASTER_KEY is not set. Generate one with: pnpm vault:key");
  }
  const key = Buffer.from(encoded, "base64");
  if (key.length !== KEY_BYTES) {
    throw new VaultError(`INFUTURE_MASTER_KEY must be ${KEY_BYTES} bytes encoded as base64.`);
  }
  const id = "kek_" + createHash("sha256").update(key).digest("hex").slice(0, 12);
  return { id, key };
}

function seal(key: Buffer, plaintext: Buffer, aad: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(aad));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]);
}

function open(key: Buffer, sealed: Buffer, aad: string): Buffer {
  if (sealed.length < IV_BYTES + TAG_BYTES) throw new VaultError("Sealed value is too short.");
  const iv = sealed.subarray(0, IV_BYTES);
  const tag = sealed.subarray(sealed.length - TAG_BYTES);
  const body = sealed.subarray(IV_BYTES, sealed.length - TAG_BYTES);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new VaultError("Could not decrypt the secret. The master key or the stored data is wrong.");
  }
}

/** Shows only the last 4 characters, e.g. "…a9F2". */
export function secretHint(secret: string): string {
  return secret.length <= 8 ? "…" : "…" + secret.slice(-4);
}

/**
 * Encrypts a secret. `context` (for example the connection id) is bound as additional authenticated
 * data, so a sealed value copied onto another connection fails to decrypt.
 */
export function encryptSecret(secret: string, master: MasterKey, context: string): SealedSecret {
  if (!secret) throw new VaultError("The secret is empty.");
  const dek = randomBytes(KEY_BYTES);
  try {
    return {
      ciphertext: seal(dek, Buffer.from(secret, "utf8"), context),
      wrappedDek: seal(master.key, dek, `${master.id}:${context}`),
      kekId: master.id,
      hint: secretHint(secret),
    };
  } finally {
    dek.fill(0);
  }
}

/** Decrypts a secret just in time. Callers should not cache the result. */
export function decryptSecret(sealed: SealedSecret, master: MasterKey, context: string): string {
  if (sealed.kekId !== master.id) {
    throw new VaultError(`This secret was sealed with ${sealed.kekId}, not ${master.id}.`);
  }
  const dek = open(master.key, sealed.wrappedDek, `${master.id}:${context}`);
  try {
    return open(dek, sealed.ciphertext, context).toString("utf8");
  } finally {
    dek.fill(0);
  }
}

/** Re-wraps the data key with a new master key. The secret itself is never decrypted. */
export function rewrapSecret(
  sealed: SealedSecret,
  from: MasterKey,
  to: MasterKey,
  context: string,
): SealedSecret {
  if (sealed.kekId !== from.id)
    throw new VaultError(`This secret was sealed with ${sealed.kekId}, not ${from.id}.`);
  const dek = open(from.key, sealed.wrappedDek, `${from.id}:${context}`);
  try {
    return { ...sealed, wrappedDek: seal(to.key, dek, `${to.id}:${context}`), kekId: to.id };
  } finally {
    dek.fill(0);
  }
}

/* ----------------------------------- Redaction ----------------------------------- */

const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{16,}/g, // Anthropic
  /sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g, // OpenAI
  /gsk_[A-Za-z0-9]{20,}/g, // Groq
  /AIza[0-9A-Za-z_-]{30,}/g, // Google
  /(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g, // GitHub
  /xox[abposr]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g, // Authorization headers
];

export const REDACTED = "[REDACTED]";

/** Removes anything that looks like a credential. Applied to every event and log line before it leaves a worker. */
export function redactSecrets(text: string, extraSecrets: readonly string[] = []): string {
  let out = text;
  for (const secret of extraSecrets) if (secret.length >= 8) out = out.split(secret).join(REDACTED);
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, REDACTED);
  return out;
}

/** Redacts every string inside a JSON-like value (event payloads, tool arguments). */
export function redactDeep<T>(value: T, extraSecrets: readonly string[] = []): T {
  if (typeof value === "string") return redactSecrets(value, extraSecrets) as T;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, extraSecrets)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactDeep(v, extraSecrets)]),
    ) as T;
  }
  return value;
}
