import { describe, expect, it } from "vitest";
import {
  decryptSecret,
  encryptSecret,
  generateMasterKey,
  loadMasterKey,
  redactDeep,
  redactSecrets,
  REDACTED,
  rewrapSecret,
  VaultError,
} from "./index";

const master = loadMasterKey(generateMasterKey());
const secret = "sk-ant-api03-EXAMPLEexampleEXAMPLEexample1234";

describe("envelope encryption", () => {
  it("round-trips a secret", () => {
    const sealed = encryptSecret(secret, master, "conn_1");
    expect(sealed.ciphertext.toString("utf8")).not.toContain("EXAMPLE");
    expect(sealed.hint).toBe("…1234");
    expect(decryptSecret(sealed, master, "conn_1")).toBe(secret);
  });

  it("produces different ciphertexts for the same secret", () => {
    const a = encryptSecret(secret, master, "conn_1");
    const b = encryptSecret(secret, master, "conn_1");
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it("fails when the sealed value is moved to another connection", () => {
    const sealed = encryptSecret(secret, master, "conn_1");
    expect(() => decryptSecret(sealed, master, "conn_2")).toThrow(VaultError);
  });

  it("fails with the wrong master key", () => {
    const sealed = encryptSecret(secret, master, "conn_1");
    const other = loadMasterKey(generateMasterKey());
    expect(() => decryptSecret(sealed, other, "conn_1")).toThrow(VaultError);
  });

  it("detects tampering", () => {
    const sealed = encryptSecret(secret, master, "conn_1");
    const tampered = Buffer.from(sealed.ciphertext);
    tampered[14] = tampered[14]! ^ 0xff;
    expect(() => decryptSecret({ ...sealed, ciphertext: tampered }, master, "conn_1")).toThrow(VaultError);
  });

  it("rotates the master key without touching the secret ciphertext", () => {
    const sealed = encryptSecret(secret, master, "conn_1");
    const next = loadMasterKey(generateMasterKey());
    const rotated = rewrapSecret(sealed, master, next, "conn_1");
    expect(rotated.ciphertext.equals(sealed.ciphertext)).toBe(true);
    expect(rotated.kekId).toBe(next.id);
    expect(decryptSecret(rotated, next, "conn_1")).toBe(secret);
  });

  it("rejects missing or malformed master keys", () => {
    expect(() => loadMasterKey(undefined)).toThrow(/pnpm vault:key/);
    expect(() => loadMasterKey(Buffer.from("short").toString("base64"))).toThrow(VaultError);
  });
});

describe("redaction", () => {
  it("removes provider keys from text", () => {
    const text = `calling with ${secret} and gsk_ABCDEFGHIJKLMNOPQRSTUVWX and Bearer abcdefghijklmnopqrstuvwxyz`;
    const out = redactSecrets(text);
    expect(out).not.toContain("EXAMPLE");
    expect(out).not.toContain("gsk_");
    expect(out.match(new RegExp(REDACTED.replace(/[[\]]/g, "\\$&"), "g"))).toHaveLength(3);
  });

  it("removes explicitly known secrets", () => {
    expect(redactSecrets("token=my-local-secret-123", ["my-local-secret-123"])).toBe(`token=${REDACTED}`);
  });

  it("redacts nested payloads", () => {
    const payload = { tool: "http", args: { headers: [`Authorization: Bearer ${"x".repeat(24)}`] }, n: 3 };
    expect(redactDeep(payload)).toEqual({
      tool: "http",
      args: { headers: [`Authorization: ${REDACTED}`] },
      n: 3,
    });
  });
});
