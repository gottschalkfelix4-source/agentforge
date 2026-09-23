import { describe, expect, it } from 'vitest';
import { parseProcNetTcp, uniquePorts } from '../src/ports.js';

const HDR = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';
const TAIL = '00000000:00000000 00:00000000 00000000  1000        0 12345 1 0000000000000000 100 0 0 10 0';
const Z6 = '00000000000000000000000000000000';

const TCP = [
  HDR,
  `   0: 00000000:1E61 00000000:0000 0A ${TAIL}`,
  `   1: 0100007F:1538 00000000:0000 0A ${TAIL}`,
  `   2: 0100007F:1538 0100007F:C350 01 ${TAIL}`,
  `   3: 0200A8C0:0BB8 00000000:0000 0A ${TAIL}`,
  '',
].join('\n');

const TCP6 = [
  HDR,
  `   0: ${Z6}:0BB8 ${Z6}:0000 0A ${TAIL}`,
  `   1: 00000000000000000000000001000000:1F90 ${Z6}:0000 0A ${TAIL}`,
  `   2: 0000000000000000FFFF00000100007F:22B8 ${Z6}:0000 0A ${TAIL}`,
  `   3: 00000000000000000000000001000000:1F91 00000000000000000000000001000000:9C40 01 ${TAIL}`,
  '',
].join('\n');

describe('parseProcNetTcp', () => {
  it('parses IPv4 LISTEN sockets only', () => {
    expect(parseProcNetTcp(TCP)).toEqual([
      { port: 7777, address: '0.0.0.0' },
      { port: 5432, address: '127.0.0.1' },
      { port: 3000, address: '192.168.0.2' },
    ]);
  });

  it('parses IPv6 LISTEN sockets', () => {
    expect(parseProcNetTcp(TCP6)).toEqual([
      { port: 3000, address: '::' },
      { port: 8080, address: '::1' },
      { port: 8888, address: '::ffff:127.0.0.1' },
    ]);
  });

  it('tolerates empty / garbage input', () => {
    expect(parseProcNetTcp('')).toEqual([]);
    expect(parseProcNetTcp('header\nnot a line\n   0: zz 0A')).toEqual([]);
  });
});

describe('uniquePorts', () => {
  it('dedupes, excludes the wsd port, prefers wildcard binds, sorts', () => {
    const all = [...parseProcNetTcp(TCP), ...parseProcNetTcp(TCP6)];
    expect(uniquePorts(all, [7777])).toEqual([
      { port: 3000, address: '::' },
      { port: 5432, address: '127.0.0.1' },
      { port: 8080, address: '::1' },
      { port: 8888, address: '::ffff:127.0.0.1' },
    ]);
  });
});

describe('docker dns', () => {
  it('ignores the embedded resolver on 127.0.0.11', () => {
    expect(uniquePorts([{ port: 35381, address: '127.0.0.11' }, { port: 5173, address: '0.0.0.0' }])).toEqual([
      { port: 5173, address: '0.0.0.0' },
    ]);
  });
});
