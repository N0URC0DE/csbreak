// Checks sendPush end to end without a real push service: the request is captured, then
// decrypted the way a browser would (RFC 8291) and the VAPID token is verified (RFC 8292).
import assert from 'node:assert/strict';
import { sendPush, b64urlDecode, b64urlEncode } from '../src/webpush.js';
import { decrypt } from './decrypt.js';

const subtle = crypto.subtle;
const enc = new TextEncoder();
const concat = (...p) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
const hmac = async (k, d) => new Uint8Array(await subtle.sign('HMAC', await subtle.importKey('raw', k, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), d));

// A fake browser subscription.
const ua = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
const uaPublic = new Uint8Array(await subtle.exportKey('raw', ua.publicKey));
const authSecret = crypto.getRandomValues(new Uint8Array(16));
const subscription = { endpoint: 'https://push.example.net/send/abc123', keys: { p256dh: b64urlEncode(uaPublic), auth: b64urlEncode(authSecret) } };

// A VAPID key pair.
const vk = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const vjwk = await subtle.exportKey('jwk', vk.privateKey);
const vapidPublic = b64urlEncode(new Uint8Array(await subtle.exportKey('raw', vk.publicKey)));
const vapid = { publicKey: vapidPublic, privateKey: vjwk.d, subject: 'https://csbreak.nourcode.com' };

let captured;
const fakeFetch = async (url, init) => { captured = { url, init }; return new Response(null, { status: 201 }); };
const message = JSON.stringify({ title: "Break's over", body: 'Time to head back ☕' });
const status = await sendPush(subscription, message, vapid, { fetchImpl: fakeFetch });
assert.equal(status, 201);
assert.equal(captured.url, subscription.endpoint);
assert.equal(captured.init.headers['Content-Encoding'], 'aes128gcm');

// The decryption itself matches the standard: RFC 8291 Appendix A example message.
{
  const uaPub = b64urlDecode('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4');
  const uaPriv = await subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', d: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
    x: b64urlEncode(uaPub.slice(1, 33)), y: b64urlEncode(uaPub.slice(33)) }, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const rfcBody = b64urlDecode('DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
  assert.equal(await decrypt(rfcBody, uaPriv, uaPub, b64urlDecode('BTBZMqHH6r4Tts7J_aSIgg')), 'When I grow up, I want to be a watermelon');
}

// --- Decrypt our own message like the browser ---
const body = captured.init.body;
assert.equal(new DataView(body.buffer, body.byteOffset).getUint32(16), 4096);
assert.equal(body[20], 65);
assert.equal(await decrypt(body, ua.privateKey, uaPublic, authSecret), message);

// --- Verify the VAPID header ---
const m = /^vapid t=([^,]+), k=(.+)$/.exec(captured.init.headers.Authorization);
assert.ok(m, 'vapid header format');
assert.equal(m[2], vapidPublic);
const [h, c, s] = m[1].split('.');
const ok = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, vk.publicKey, b64urlDecode(s), enc.encode(`${h}.${c}`));
assert.ok(ok, 'JWT signature verifies');
const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(c)));
assert.equal(claims.aud, 'https://push.example.net');
assert.equal(claims.sub, vapid.subject);
assert.ok(claims.exp > Date.now() / 1000 && claims.exp <= Date.now() / 1000 + 24 * 3600);

console.log('webpush: RFC 8291 example decrypts, our encryption round-trips, VAPID token verifies');
