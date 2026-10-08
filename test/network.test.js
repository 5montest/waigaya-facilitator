import test from 'node:test';
import assert from 'node:assert/strict';
import { addressAllowed, requestAllowed } from '../src/network.js';

const access = { hosts: ['127.0.0.1', 'localhost', '192.168.8.10'], networks: ['127.0.0.0/8', '::1/128', '192.168.8.0/24'] };
function req({ address = '192.168.8.50', host = '192.168.8.10:8765', port = 8765, origin, encrypted = false } = {}) {
  return { socket: { remoteAddress: address, localPort: port, encrypted }, headers: { host, ...(origin ? { origin } : {}) } };
}
test('LANのCIDRは指定したサブネットとループバックを許可し、他のネットワークを拒否する', () => {
  for (const address of ['192.168.8.50','::ffff:192.168.8.51','127.0.0.1','::1']) assert.equal(addressAllowed(address, access.networks), true);
  for (const address of ['192.168.9.50','172.18.0.2','8.8.8.8','garbage',undefined]) assert.equal(addressAllowed(address, access.networks), false);
});
test('LANでも任意のHost・異なるポート・別サイトOriginによる読み書きを受け付けない', () => {
  assert.equal(requestAllowed(req(), access), true);
  assert.equal(requestAllowed(req({ origin:'http://192.168.8.10:8765' }), access, true), true);
  for (const params of [{host:'evil.example:8765'},{host:'192.168.8.10:9999'},{host:'evil.example@192.168.8.10:8765'},{address:'192.168.9.3'},{origin:'http://evil.example:8765'}]) assert.equal(requestAllowed(req(params), access), false);
  assert.equal(requestAllowed(req(), access, true), false);
});
test('HTTPSの書き込みとWebSocketには同じHTTPS Originを要求する', () => {
  const secure = { encrypted:true, port:8766, host:'192.168.8.10:8766' };
  assert.equal(requestAllowed(req({...secure,origin:'https://192.168.8.10:8766'}), access,true),true);
  assert.equal(requestAllowed(req({...secure,origin:'http://192.168.8.10:8766'}),access,true),false);
});
