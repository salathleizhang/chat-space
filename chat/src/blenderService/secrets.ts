import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
/** Encrypted at rest; a restored SQLite file alone does not disclose sandbox credentials. */
export class SandboxSecrets {
  private readonly key: Buffer;
  constructor(secret: string) {
    if (secret.length < 32) throw new Error("Blender encryption secret too short");
    this.key = createHash("sha256").update("sandbox-secrets:" + secret).digest();
  }
  generate() { return { control: randomBytes(32).toString("hex"), desktop: randomBytes(24).toString("hex") }; }
  seal(value: { control: string; desktop: string }, session: string, epoch: number): string {
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(`${session}:${epoch}`));
    const bytes = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString("base64url");
  }
  open(value: string, session: string, epoch: number): { control: string; desktop: string } {
    const bytes = Buffer.from(value, "base64url"), cipher = createDecipheriv("aes-256-gcm", this.key, bytes.subarray(0, 12));
    cipher.setAAD(Buffer.from(`${session}:${epoch}`)); cipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString());
  }
}
