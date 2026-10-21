// End-to-end check against `wrangler dev` (local Durable Objects + alarms):
// a break's notifications (60%, 85%, end) arrive in order at their times and decrypt, cancelled
// ones never arrive, and other websites / bad input are rejected.
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
  // 1) Three notifications for one break arrive in order, each at its time.
  const a = await fakeSubscription('/device-a');
  const t0 = Date.now();
  const notifications = [
    { at: t0 + 2000, title: '6 min left on your break', body: 'Back at 6:03 PM.', ttl: 360 },
    { at: t0 + 4000, title: 'Almost time: 2m 15s left', body: 'Start heading back.' },
    { at: t0 + 6000, title: "Break's over ☕", body: 'Time to head back to your desk.', urgent: true }
  ];
  let r = await post('/schedule', { id: 'device-a-0123456789', subscription: a.sub, notifications });
  assert.equal(r.status, 200, 'schedule accepted');
  assert.equal(r.headers.get('access-control-allow-origin'), ORIGIN);

  // 2) Another device schedules, then cancels: nothing should arrive for it.
  const b = await fakeSubscription('/device-b');
  assert.equal((await post('/schedule', { id: 'device-b-0123456789', subscription: b.sub, notifications: [{ at: Date.now() + 2500, title: 'x' }] })).status, 200);
  assert.equal((await post('/cancel', { id: 'device-b-0123456789' })).status, 200);

  await sleep(9000);
  const forA = received.filter(x => x.path === '/device-a');
  assert.equal(forA.length, 3, 'three pushes for device A');
  const lateness = [];
  for (let i = 0; i < 3; i++) {
    const msg = JSON.parse(await decrypt(forA[i].body, a.ua.privateKey, a.pub, a.auth));
    assert.equal(msg.title, notifications[i].title, `push ${i + 1} in order`);
    assert.equal(msg.urgent, !!notifications[i].urgent);
    lateness.push(forA[i].at - notifications[i].at);
    assert.ok(lateness[i] >= -50 && lateness[i] < 2000, `push ${i + 1} on time (off by ${lateness[i]} ms)`);
  }
  assert.match(forA[0].headers.authorization, /^vapid t=/);
  assert.equal(forA[0].headers.ttl, '360', 'reminder expires with the break');
  assert.equal(forA[2].headers.ttl, '600', 'default validity');
  assert.equal(forA[0].headers.urgency, 'high');
  assert.equal(received.filter(x => x.path === '/device-b').length, 0, 'cancelled push never sent');

  // 3) Rejections.
  const one = at => [{ at, title: 'x' }];
  assert.equal((await post('/schedule', { id: 'device-a-0123456789', subscription: a.sub, notifications: one(Date.now() + 5000) }, 'https://evil.example')).status, 403, 'other origins rejected');
  assert.equal((await post('/schedule', { id: 'device-a-0123456789', subscription: a.sub, notifications: one(Date.now() - 1000) })).status, 400, 'past time rejected');
  assert.equal((await post('/schedule', { id: 'device-a-0123456789', subscription: a.sub, notifications: Array(6).fill(one(Date.now() + 5000)[0]) })).status, 400, 'too many rejected');
  assert.equal((await post('/schedule', { id: 'x', subscription: a.sub, notifications: one(Date.now() + 5000) })).status, 400, 'bad id rejected');
  assert.equal((await post('/schedule', { id: 'device-a-0123456789', subscription: { endpoint: 'nope' }, notifications: one(Date.now() + 5000) })).status, 400, 'bad subscription rejected');

  console.log(`server: 3 pushes delivered in order (late by ${lateness.join(' / ')} ms), cancel works, bad requests rejected`);
} finally {
  push.close();
}
