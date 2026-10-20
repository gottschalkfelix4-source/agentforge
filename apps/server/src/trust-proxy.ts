import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';

/** Value for Fastify's `trustProxy` option (a hop count becomes a trust function). */
export type TrustProxy = boolean | string[] | ((address: string, hop: number) => boolean);

/**
 * Fastify `trustProxy` from AGENTFORGE_TRUST_PROXY. Trusting X-Forwarded-* from everyone lets any client
 * spoof its IP (bypassing the per-IP login/setup rate limit) and its protocol, so by default nobody is
 * trusted on the host, and in a container only loopback and the container's own networks (a reverse
 * proxy on the docker network).
 *
 * Values: `true` (trust every hop – only behind a proxy that strips client headers), `false`,
 * a hop count (`1` = the proxy directly in front), or a comma list of IPs/CIDRs and the keywords
 * `loopback`, `linklocal`, `uniquelocal`.
 */
export function parseTrustProxy(
  value: string | undefined,
  inContainer: boolean,
  ifaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): TrustProxy {
  const v = value?.trim();
  if (!v) return inContainer ? ['loopback', ...localSubnets(ifaces)] : false;
  const lower = v.toLowerCase();
  if (lower === 'true') return true;
  if (lower === 'false' || lower === '0') return false;
  if (/^\d+$/.test(v)) {
    const hops = Number(v);
    return (_address, hop) => hop < hops;
  }
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

/** CIDRs of the networks this machine is attached to (no loopback, no IPv6 link-local). */
function localSubnets(ifaces: NodeJS.Dict<NetworkInterfaceInfo[]>): string[] {
  return Object.values(ifaces)
    .flatMap((list) => list ?? [])
    .filter((i) => !i.internal && i.cidr && !i.address.toLowerCase().startsWith('fe80:'))
    .map((i) => i.cidr!);
}
