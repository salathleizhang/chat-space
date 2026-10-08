import { sha256 } from "@noble/hashes/sha2.js";
import { hmac } from "@noble/hashes/hmac.js";
import { Buffer } from "buffer";
import path from "path-browserify";
export const { join, dirname, basename, extname, normalize, resolve, sep } = path;
export const posix = path;
export const randomUUID = () => crypto.randomUUID();
export const homedir = () => "/browser";
export const tmpdir = () => "/browser/tmp";
export const fileURLToPath = (url: string | URL) => new URL(url).pathname;
export function createHash(algorithm: string) { return digest(algorithm); }
export function createHmac(algorithm: string, key: string | Uint8Array) { return digest(algorithm, key); }
function digest(algorithm: string, key?: string | Uint8Array) {
  if (algorithm !== "sha256") throw new Error(`Unsupported hash: ${algorithm}`);
  const parts: Uint8Array[] = [];
  const hash = {
    update(input: string | Uint8Array) { parts.push(typeof input === "string" ? new TextEncoder().encode(input) : input); return hash; },
    digest(encoding?: string) {
      const data = new Uint8Array(parts.reduce((n, bytes) => n + bytes.length, 0));
      let offset = 0; for (const part of parts) { data.set(part, offset); offset += part.length; }
      const result = Buffer.from(key === undefined ? sha256(data) : hmac(sha256, typeof key === "string" ? new TextEncoder().encode(key) : key, data));
      return encoding ? result.toString(encoding as never) : result;
    },
  };
  return hash;
}
/** Each bounded worker owns one request/job; contexts never cross worker boundaries. */
export class AsyncLocalStorage<T> {
  private value?: T;
  getStore() { return this.value; }
  run<R>(value: T, callback: () => R): R { this.value = value; return callback(); }

}
const unavailable = async () => { throw new Error("Native filesystem is unavailable in browser mode"); };
export const mkdir = unavailable, readdir = unavailable, readFile = unavailable, rename = unavailable, rm = unavailable, stat = unavailable, writeFile = unavailable;
