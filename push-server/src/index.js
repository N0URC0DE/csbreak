// Break Timer push server.
// The app asks to be notified when a break ends (POST /schedule) and cancels it on Stop/Cancel
// (POST /cancel). Each device gets its own Durable Object, which keeps the pending notification
// and wakes up with an alarm at the break's end time to send it. Nothing is kept after sending.
import { DurableObject } from 'cloudflare:workers';
import { sendPush } from './webpush.js';

const MAX_AHEAD_MS = 6 * 60 * 60 * 1000; // breaks are at most a few hours
const ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

function cors(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = env.ALLOWED_ORIGINS.split(',').map(s => s.trim());
  return allowed.includes(origin)
    ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400', Vary: 'Origin' }
    : null;
}

function json(status, data, headers) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function validSubscription(s, env) {
  try {
    // Real push services are https; ALLOW_HTTP_PUSH (local .dev.vars only) lets tests use a local endpoint.
    const protocols = env.ALLOW_HTTP_PUSH === '1' ? ['https:', 'http:'] : ['https:'];
    return s && typeof s.endpoint === 'string' && protocols.includes(new URL(s.endpoint).protocol) &&
      s.keys && typeof s.keys.p256dh === 'string' && typeof s.keys.auth === 'string' &&
      s.keys.p256dh.length < 200 && s.keys.auth.length < 100 && s.endpoint.length < 2000;
  } catch { return false; }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = cors(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: headers ? 204 : 403, headers: headers || {} });
    if (request.method === 'GET' && url.pathname === '/') return new Response('Break Timer push server');
    if (request.method !== 'POST' || !['/schedule', '/cancel'].includes(url.pathname)) return json(404, { error: 'not found' }, headers);
    if (!headers) return json(403, { error: 'origin not allowed' });

    let body;
    try {
      const text = await request.text();
      if (text.length > 4096) return json(413, { error: 'too large' }, headers);
      body = JSON.parse(text);
    } catch { return json(400, { error: 'bad json' }, headers); }
    if (!body || !ID_RE.test(body.id || '')) return json(400, { error: 'bad id' }, headers);

    const stub = env.BREAKS.get(env.BREAKS.idFromName(body.id));
    if (url.pathname === '/cancel') {
      await stub.cancel();
      return json(200, { ok: true }, headers);
    }

    const endAt = Number(body.endAt);
    const now = Date.now();
    if (!validSubscription(body.subscription, env)) return json(400, { error: 'bad subscription' }, headers);
    if (!Number.isFinite(endAt) || endAt <= now || endAt > now + MAX_AHEAD_MS) return json(400, { error: 'bad endAt' }, headers);
    const message = {
      title: String(body.title || "Break's over").slice(0, 80),
      body: String(body.body || 'Time to head back.').slice(0, 160)
    };
    await stub.schedule({ subscription: body.subscription, endAt, message });
    return json(200, { ok: true, endAt }, headers);
  }
};

export class BreakAlarm extends DurableObject {
  // One pending notification per device; scheduling again replaces it.
  async schedule(job) {
    await this.ctx.storage.put('job', job);
    await this.ctx.storage.setAlarm(job.endAt);
  }

  async cancel() {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  async alarm() {
    const job = await this.ctx.storage.get('job');
    if (!job) return;
    const status = await sendPush(job.subscription, JSON.stringify(job.message), {
      publicKey: this.env.VAPID_PUBLIC_KEY,
      privateKey: this.env.VAPID_PRIVATE_KEY,
      subject: this.env.VAPID_SUBJECT
    });
    // Retry later on push-service hiccups (throwing makes the alarm retry with backoff);
    // anything else (sent, or the subscription is gone/invalid) ends the job.
    if (status === 429 || status >= 500) throw new Error(`push service returned ${status}`);
    await this.ctx.storage.deleteAll();
  }
}
