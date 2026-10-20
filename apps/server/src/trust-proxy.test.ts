import type { NetworkInterfaceInfo } from 'node:os';
import { describe, expect, it } from 'vitest';
import { parseTrustProxy } from './trust-proxy.js';

const iface = (address: string, cidr: string, internal = false): NetworkInterfaceInfo =>
  ({ address, cidr, internal, family: address.includes(':') ? 'IPv6' : 'IPv4', netmask: '', mac: '' }) as NetworkInterfaceInfo;

const ifaces = {
  lo: [iface('127.0.0.1', '127.0.0.1/8', true)],
  eth0: [iface('172.18.0.5', '172.18.0.5/16'), iface('fe80::1', 'fe80::1/64')],
};

describe('parseTrustProxy', () => {
  it('trusts nobody on the host by default', () => {
    expect(parseTrustProxy(undefined, false, ifaces)).toBe(false);
    expect(parseTrustProxy('  ', false, ifaces)).toBe(false);
  });

  it('trusts loopback and the docker network in a container by default', () => {
    expect(parseTrustProxy(undefined, true, ifaces)).toEqual(['loopback', '172.18.0.5/16']);
  });

  it('parses booleans, hop counts and address lists', () => {
    expect(parseTrustProxy('true', true, ifaces)).toBe(true);
    expect(parseTrustProxy('FALSE', true, ifaces)).toBe(false);
    expect(parseTrustProxy('0', true, ifaces)).toBe(false);
    const oneHop = parseTrustProxy('1', false, ifaces) as (address: string, hop: number) => boolean;
    expect([oneHop('10.0.0.2', 0), oneHop('10.0.0.3', 1)]).toEqual([true, false]);
    expect(parseTrustProxy('192.168.1.10, 10.0.0.0/8,loopback', false, ifaces)).toEqual(['192.168.1.10', '10.0.0.0/8', 'loopback']);
  });
});
