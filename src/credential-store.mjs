import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export class CredentialStore {
  constructor(directory) {
    this.directory = directory;
    this.keyPath = path.join(directory, ".credential-key");
    this.storePath = path.join(directory, "credentials.enc");
    mkdirSync(directory, { recursive: true });
  }

  getKey() {
    if (!existsSync(this.keyPath)) {
      writeFileSync(this.keyPath, randomBytes(32), { mode: 0o600 });
      chmodSync(this.keyPath, 0o600);
    }
    const key = readFileSync(this.keyPath);
    if (key.length !== 32) throw new Error("本地凭据密钥已损坏");
    return key;
  }

  readAll() {
    if (!existsSync(this.storePath)) return {};
    const payload = JSON.parse(readFileSync(this.storePath, "utf8"));
    const decipher = createDecipheriv("aes-256-gcm", this.getKey(), Buffer.from(payload.iv, "base64"));
    decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(payload.data, "base64")),
      decipher.final()
    ]).toString("utf8");
    return JSON.parse(plain);
  }

  writeAll(values) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.getKey(), iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(values), "utf8"), cipher.final()]);
    const payload = JSON.stringify({
      version: 1,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: encrypted.toString("base64")
    });
    const temporary = `${this.storePath}.tmp`;
    writeFileSync(temporary, payload, { mode: 0o600 });
    renameSync(temporary, this.storePath);
    chmodSync(this.storePath, 0o600);
  }

  get(provider) {
    return this.readAll()[provider] ?? null;
  }

  set(provider, value) {
    const values = this.readAll();
    values[provider] = value;
    this.writeAll(values);
  }

  delete(provider) {
    const values = this.readAll();
    delete values[provider];
    this.writeAll(values);
  }
}
