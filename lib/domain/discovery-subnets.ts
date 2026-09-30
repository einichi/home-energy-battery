const IPV4_24 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.0\/24$/;

function subnetValues(value: unknown): string[] {
  const values = Array.isArray(value) ? value : String(value ?? "").split(",");
  return [...new Set(values.map((item) => String(item).trim()).filter(Boolean))];
}

export function isPrivateDiscoverySubnet(value: unknown): boolean {
  const match = IPV4_24.exec(String(value));
  if (!match) return false;
  const first = Number(match[1]);
  const second = Number(match[2]);
  const third = Number(match[3]);
  if ([first, second, third].some((octet) => octet < 0 || octet > 255)) return false;
  return first === 10
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168);
}

export function normalizePrivateDiscoverySubnets(value: unknown): string[] {
  return subnetValues(value).filter(isPrivateDiscoverySubnet);
}

export function invalidDiscoverySubnets(value: unknown): string[] {
  return subnetValues(value).filter((subnet) => !isPrivateDiscoverySubnet(subnet));
}
