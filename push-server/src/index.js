// Break Timer push server.
// The app sends the notifications for a break (e.g. at 60%, 85% and the end) with POST /schedule
// and cancels them on Stop/Cancel with POST /cancel. Each device gets its own Durable Object, which
// keeps the pending notifications and wakes up with an alarm at each one's time to send it.
// Nothing is kept once the last one is sent.
import { DurableObject } from 'cloudflare:workers';
import { sendPush } from './webpush.js';

const MAX_AHEAD_MS = 6 * 60 * 60 * 1000; // breaks are at most a few hours
const ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const MAX_NOTIFICATIONS = 5;

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

    const now = Date.now();
    if (!validSubscription(body.subscription, env)) return json(400, { error: 'bad subscription' }, headers);
    const list = body.notifications;
    if (!Array.isArray(list) || list.length < 1 || list.length > MAX_NOTIFICATIONS) return json(400, { error: 'bad notifications' }, headers);
    const queue = [];
    for (const n of list) {
      const at = Number(n && n.at);
      if (!Number.isFinite(at) || at <= now || at > now + MAX_AHEAD_MS) return json(400, { error: 'bad time' }, headers);
      // How long the push service may hold it if the phone is offline (seconds).
      const ttl = Math.round(Math.min(3600, Math.max(30, Number(n.ttl) || 600)));
      queue.push({ at, ttl, message: {
        title: String(n.title || "Break's over").slice(0, 80),
        body: String(n.body || '').slice(0, 160),
        urgent: !!n.urgent
      } });
    }
    queue.sort((a, b) => a.at - b.at);
    await stub.schedule({ subscription: body.subscription, queue });
    return json(200, { ok: true, count: queue.length }, headers);
  }
};

export class BreakAlarm extends DurableObject {
  // One break's notifications per device; scheduling again replaces them.
  async schedule(job) {
    await this.ctx.storage.put('job', job);
    await this.ctx.storage.setAlarm(job.queue[0].at);
  }

  async cancel() {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  async alarm() {
    const job = await this.ctx.storage.get('job');
    if (!job) return;
    const now = Date.now() + 500;
    const due = job.queue.filter(n => n.at <= now);
    const later = job.queue.filter(n => n.at > now);
    if (due.length) {
      // If several came due at once (a delayed alarm), only the latest is still worth showing.
      const next = due[due.length - 1];
      const status = await sendPush(job.subscription, JSON.stringify(next.message), {
        publicKey: this.env.VAPID_PUBLIC_KEY,
        privateKey: this.env.VAPID_PRIVATE_KEY,
        subject: this.env.VAPID_SUBJECT
      }, { ttl: next.ttl || 600 });
      // Retry later on push-service hiccups (throwing makes the alarm retry with backoff).
      if (status === 429 || status >= 500) throw new Error(`push service returned ${status}`);
      // The subscription is gone (app uninstalled, permission revoked): drop the rest too.
      if (status === 404 || status === 410) { await this.ctx.storage.deleteAll(); return; }
    }
    if (later.length) {
      await this.ctx.storage.put('job', { subscription: job.subscription, queue: later });
      await this.ctx.storage.setAlarm(later[0].at);
    } else {
      await this.ctx.storage.deleteAll();
    }
  }
}
