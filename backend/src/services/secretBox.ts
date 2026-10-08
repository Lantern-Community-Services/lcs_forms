import crypto from "node:crypto";
import { env, isProd, onAppService } from "../env.js";

/**
 * Encryption for secrets the app has to keep in the database (people's
 * Microsoft refresh tokens): AES-256-GCM with TOKEN_ENCRYPTION_KEY, 32 random
 * bytes as base64, from Key Vault in Azure.
 *
 * Each value is bound to the row it belongs to (`context`, e.g. the user id) as
 * authenticated data, so a ciphertext copied onto another person's row doesn't
 * open. Changing the key makes every stored value unreadable, which is safe:
 * the refresh tokens are simply collected again at each person's next sign-in.
 *
 * Without a key, local development derives one from JWT_SECRET. In production
 * (or on App Service) nothing is stored without a real key.
 */

function loadKey(): Buffer | null {
  if (env.tokenEncryptionKey) {
    const key = Buffer.from(env.tokenEncryptionKey, "base64");
    if (key.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must be 32 random bytes, base64 (openssl rand -base64 32).");
    return key;
  }
  if (isProd || onAppService) return null;
  return Buffer.from(crypto.hkdfSync("sha256", env.jwtSecret, "lantern-forms", "token-encryption-dev", 32));
}

const key = loadKey();

export const encryptionAvailable = () => key !== null;

const b64 = (b: Buffer) => b.toString("base64url");

export function seal(plain: string, context: string): string {
  if (!key) throw new Error("TOKEN_ENCRYPTION_KEY isn't set.");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(context));
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `v1.${b64(iv)}.${b64(cipher.getAuthTag())}.${b64(ct)}`;
}

/** The plain value, or null when it can't be opened (another key, another row, tampered). */
export function unseal(sealed: string, context: string): string | null {
  if (!key) return null;
  const [v, iv, tag, ct] = sealed.split(".");
  if (v !== "v1" || !iv || !tag || !ct) return null;
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
