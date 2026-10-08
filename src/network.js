import { isIP } from 'node:net';

const ipv4 = value => value.split('.').reduce((n, part) => (n << 8) | Number(part), 0) >>> 0;
export function addressAllowed(address, networks) {
  const peer = address?.replace(/^::ffff:/, '');
  return networks.some(network => {
    if (network === '::1/128') return peer === '::1';
    const [base, prefix] = network.split('/');
    if (isIP(peer) !== 4 || isIP(base) !== 4 || !/^\d+$/.test(prefix ?? '')) return false;
    const bits = Number(prefix);
    if (bits < 0 || bits > 32) return false;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (ipv4(peer) & mask) === (ipv4(base) & mask);
  });
}

export function requestAllowed(req, { hosts, networks }, write = false) {
  if (!addressAllowed(req.socket.remoteAddress, networks)) return false;
  const host = req.headers.host ?? '';
  if (!/^([a-z0-9.-]+|\[[0-9a-f:]+\])(?::[0-9]+)?$/i.test(host)) return false;
  const protocol = req.socket.encrypted ? 'https:' : 'http:';
  const target = new URL(`${protocol}//${host}`);
  if (!hosts.includes(target.hostname.toLowerCase())) return false;
  if (Number(target.port || (protocol === 'https:' ? 443 : 80)) !== req.socket.localPort) return false;
  return write ? req.headers.origin === target.origin : !req.headers.origin || req.headers.origin === target.origin;
}
