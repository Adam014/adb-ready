import { isIP } from "node:net";

const LOOPBACK_HOSTS = ["127.0.0.1", "::1"] as const;

export function connectionHosts(host: string): readonly string[] {
  const trimmed = host.trim();
  if (trimmed.toLowerCase() === "localhost") return LOOPBACK_HOSTS;
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return [trimmed.slice(1, -1)];
  return [trimmed];
}

export function hostForUrl(host: string): string {
  if (host.startsWith("[") && host.endsWith("]")) return host;
  return isIP(host) === 6 ? `[${host}]` : host;
}

export function httpEndpoint(host: string, port: number): string {
  return `http://${hostForUrl(host)}:${String(port)}`;
}
