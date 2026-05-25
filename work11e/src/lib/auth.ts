export const AUTH_COOKIE_NAME = "raven_auth";

function bytesToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function hashAccessKey(accessKey: string, salt = "raven-local-salt"): Promise<string> {
  const payload = new TextEncoder().encode(`${salt}:${accessKey}`);
  const digest = await crypto.subtle.digest("SHA-256", payload);
  return bytesToHex(digest);
}

export function getAccessKey(): string | undefined {
  return process.env.RAVEN_ACCESS_KEY?.trim();
}

export function getSessionSalt(): string {
  return process.env.RAVEN_SESSION_SALT?.trim() || "raven-local-salt";
}
