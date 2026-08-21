const CSRF_COOKIE = "vttmaps.csrf";
const DEVICE_COOKIE = "vttmaps_device_fp";
const DEVICE_KEY = "vttmaps.device_fp";
const COOKIE_CONSENT_KEY = "vttmaps.cookie_consent";

function readCookie(name: string): string | null {
  const encoded = `${encodeURIComponent(name)}=`;
  const parts = document.cookie.split("; ");
  for (const part of parts) {
    if (part.startsWith(encoded)) {
      return decodeURIComponent(part.slice(encoded.length));
    }
  }
  return null;
}

function writeCookie(name: string, value: string, maxAgeSeconds: number): void {
  document.cookie = `${encodeURIComponent(name)}=${encodeURIComponent(value)}; path=/; max-age=${maxAgeSeconds}; SameSite=Lax`;
}

function hashFNV1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

function getDeviceFingerprint(): string {
  const existing = localStorage.getItem(DEVICE_KEY);
  if (existing) return existing;

  const randomSeed = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`;
  const source = [
    navigator.userAgent,
    navigator.language,
    navigator.platform,
    `${window.screen.width}x${window.screen.height}`,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    randomSeed
  ].join("|");
  const fp = hashFNV1a(source);
  localStorage.setItem(DEVICE_KEY, fp);
  writeCookie(DEVICE_COOKIE, fp, 60 * 60 * 24 * 365);
  return fp;
}

async function requestHeaders(mutating: boolean): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    "x-device-fingerprint": getDeviceFingerprint()
  };
  const consent = localStorage.getItem(COOKIE_CONSENT_KEY);
  if (consent) headers["x-cookie-consent"] = consent;
  if (!mutating) return headers;

  const token = readCookie(CSRF_COOKIE);
  return token ? { ...headers, "x-csrf-token": token } : headers;
}

export async function getJson<T>(path: string): Promise<T> {
  const headers = await requestHeaders(false);
  const response = await fetch(path, { credentials: "include", headers });
  if (!response.ok) throw new Error(`request failed: ${response.status}`);
  return response.json() as Promise<T>;
}

export async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const headers = await requestHeaders(true);
  const response = await fetch(path, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!response.ok) throw new Error(`request failed: ${response.status}`);
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export async function deleteJson<T>(path: string): Promise<T> {
  const headers = await requestHeaders(true);
  const response = await fetch(path, {
    method: "DELETE",
    credentials: "include",
    headers
  });
  if (!response.ok) throw new Error(`request failed: ${response.status}`);
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
