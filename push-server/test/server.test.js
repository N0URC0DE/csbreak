// End-to-end check against `wrangler dev` (local Durable Objects + alarms):
// a scheduled break notification arrives at its time and decrypts, a cancelled one never
// arrives, and other websites / bad input are rejected.
// Run: npx wrangler dev --port 8790  (with ALLOW_HTTP_PUSH=1 in .dev.vars), then node test/server.test.js
import assert from 'node:assert/strict';
import http from 'node:http';
import { b64urlEncode } from '../src/webpush.js';
import { decrypt } from './decrypt.js';

const SERVER = process.env.SERVER || 'http://127.0.0.1:8790';
const ORIGIN = 'http://localhost:8765';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Stand-in push service that records what it receives.
const received = [];
const push = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => { received.push({ path: req.url, headers: req.headers, body: new Uint8Array(Buffer.concat(chunks)), at: Date.now() }); res.writeHead(201).end(); });
});
await new Promise(r => push.listen(8799, '127.0.0.1', r));

async function fakeSubscription(path) {
  const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { ua, pub, auth, sub: { endpoint: `http://127.0.0.1:8799${path}`, keys: { p256dh: b64urlEncode(pub), auth: b64urlEncode(auth) } } };
}
const post = (path, body, origin = ORIGIN) => fetch(SERVER + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) });

try {
  // 1) Scheduled notification arrives at the end time and decrypts.
  const a = await fakeSubscription('/device-a');
  const endAt = Date.now() + 3000;
  let r = await post('/schedule', { id: 'device-a-0123456789', subscription: a.sub, endAt, title: "Break's over", body: 'Time to head back ☕' });
  assert.equal(r.status, 200, 'schedule accepted');
  assert.equal(r.headers.get('access-control-allow-origin'), ORIGIN);

  // 2) Another device schedules, then cancels: nothing should arrive for it.
  const b = await fakeSubscription('/device-b');
  assert.equal((await post('/schedule', { id: 'device-b-0123456789', subscription: b.sub, endAt: Date.now() + 2500 })).status, 200);
  assert.equal((await post('/cancel', { id: 'device-b-0123456789' })).status, 200);

  await sleep(6000);
  const forA = received.filter(x => x.path === '/device-a');
  assert.equal(forA.length, 1, 'exactly one push for device A');
  const lateBy = forA[0].at - endAt;
  assert.ok(lateBy >= -50 && lateBy < 2000, `push sent at the end time (off by ${lateBy} ms)`);
  assert.match(forA[0].headers.authorization, /^vapid t=/);
  const msg = JSON.parse(await decrypt(forA[0].body, a.ua.privateKey, a.pub, a.auth));
  assert.deepEqual(msg, { title: "Break's over", body: 'Time to head back ☕' });
  assert.equal(received.filter(x => x.path === '/device-b').length, 0, 'cancelled push never sent');

  // 3) Rejections.
  assert.equal((await post('/schedule', { id: 'device-a-0123456789', subscription: a.sub, endAt: Date.now() + 5000 }, 'https://evil.example')).status, 403, 'other origins rejected');
  assert.equal((await post('/schedule', { id: 'device-a-0123456789', subscription: a.sub, endAt: Date.now() - 1000 })).status, 400, 'past endAt rejected');
  assert.equal((await post('/schedule', { id: 'x', subscription: a.sub, endAt: Date.now() + 5000 })).status, 400, 'bad id rejected');
  assert.equal((await post('/schedule', { id: 'device-a-0123456789', subscription: { endpoint: 'nope' }, endAt: Date.now() + 5000 })).status, 400, 'bad subscription rejected');

  console.log(`server: push delivered ${lateBy} ms after the end time, cancel works, bad requests rejected`);
} finally {
  push.close();
}
