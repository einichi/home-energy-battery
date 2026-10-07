/**
 * Lexical IP address classification, independent of DNS or routing.
 *
 * Used by the HTTP layer to reject requests whose real client address is not a
 * private / loopback address, as a network-layer guard against accidental
 * internet exposure of this unauthenticated control plane.
 */

export function ipv4ToInt(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = ((value << 8) | octet) >>> 0;
  }
  return value >>> 0;
}

function isPrivateIpv4(address: string): boolean {
  const value = ipv4ToInt(address);
  if (value === null) return false;
  const first = value >>> 24;
  const second = (value >>> 16) & 0xff;
  if (first === 10) return true; // 10.0.0.0/8
  if (first === 127) return true; // 127.0.0.0/8 (loopback)
  if (first === 172 && second >= 16 && second <= 31) return true; // 172.16.0.0/12
  if (first === 192 && second === 168) return true; // 192.168.0.0/16
  if (first === 169 && second === 254) return true; // 169.254.0.0/16 (link-local)
  if (first === 100 && second >= 64 && second <= 127) return true; // 100.64.0.0/10 (CGNAT)
  return false;
}

/** Expand an IPv6 literal (including `::` compression and embedded IPv4) to eight groups. */
export function ipv6Groups(address: string): number[] | null {
  const zoneIndex = address.indexOf("%");
  const bare = zoneIndex === -1 ? address : address.slice(0, zoneIndex);
  const parts = bare.split("::");
  if (parts.length > 2) return null;
  const left = parts[0] ?? "";
  const right = parts.length === 2 ? parts[1] ?? "" : undefined;

  function parseGroups(segment: string): number[] | null {
    if (!segment) return [];
    const groups: number[] = [];
    for (const piece of segment.split(":")) {
      if (piece.includes(".")) {
        const embedded = ipv4ToInt(piece);
        if (embedded === null) return null;
        groups.push((embedded >>> 16) & 0xffff, embedded & 0xffff);
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return null;
        groups.push(parseInt(piece, 16));
      }
    }
    return groups;
  }

  const leftGroups = parseGroups(left);
  const rightGroups = right === undefined ? null : parseGroups(right);
  if (leftGroups === null || (rightGroups === null && right !== undefined)) return null;
  if (right === undefined) return leftGroups.length === 8 ? leftGroups : null;
  const missing = 8 - leftGroups.length - rightGroups!.length;
  if (missing < 0) return null;
  return [...leftGroups, ...Array<number>(missing).fill(0), ...rightGroups!];
}

function isPrivateIpv6(address: string): boolean {
  const groups = ipv6Groups(address);
  if (!groups) return false;
  if (groups[0] === 0 && groups.slice(1, 7).every((group) => group === 0) && groups[7] === 1) {
    return true; // ::1
  }
  const isMapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  if (isMapped) {
    const embedded = ((groups[6]! << 16) | groups[7]!) >>> 0;
    const dotted = [24, 16, 8, 0].map((shift) => (embedded >>> shift) & 0xff).join(".");
    return isPrivateIpv4(dotted);
  }
  const first = groups[0]!;
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 (ULA)
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 (link-local)
  return false;
}

/** True when the value is a syntactically valid private, loopback, or link-local address. */
export function isPrivateAddress(value: string | null | undefined): boolean {
  const address = String(value ?? "").trim();
  if (!address) return false;
  const version = ipv4ToInt(address) !== null ? 4 : ipv6Groups(address) !== null ? 6 : 0;
  if (version === 4) return isPrivateIpv4(address);
  if (version === 6) return isPrivateIpv6(address);
  return false;
}

export function isLoopbackAddress(value: string | null | undefined): boolean {
  const address = String(value ?? "").trim();
  if (!address) return false;
  const ipv4 = ipv4ToInt(address);
  if (ipv4 !== null) return ipv4 >>> 24 === 127;
  const groups = ipv6Groups(address);
  if (!groups) return false;
  if (groups[0] === 0 && groups.slice(1, 7).every((group) => group === 0) && groups[7] === 1) return true;
  const isMapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  if (!isMapped) return false;
  const embedded = ((groups[6]! << 16) | groups[7]!) >>> 0;
  return embedded >>> 24 === 127;
}
