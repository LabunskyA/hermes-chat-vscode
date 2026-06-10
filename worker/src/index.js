/**
 * Referral redirect Worker.
 *
 * GET /        -> increments click counters, then 302-redirects to the Ace Data
 *                 referral link (pure redirect; attribution cookie set normally).
 * GET /stats   -> returns aggregate click counters as JSON. If a STATS_TOKEN
 *                 secret is set, requires ?token=... to match.
 *
 * Bindings (see wrangler.toml):
 *   CLICKS       KV namespace for counters
 *   STATS_TOKEN  (optional secret) gate for /stats
 */

const REFERRAL_TARGET = 'https://share.acedata.cloud/r/1uN9UXvGv7';

function todayKey() {
  return 'clicks:' + new Date().toISOString().slice(0, 10); // clicks:YYYY-MM-DD
}

async function bump(kv, key) {
  const current = parseInt((await kv.get(key)) || '0', 10) || 0;
  await kv.put(key, String(current + 1));
  return current + 1;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/stats') {
      if (env.STATS_TOKEN && url.searchParams.get('token') !== env.STATS_TOKEN) {
        return new Response('Forbidden', { status: 403 });
      }
      const total = parseInt((await env.CLICKS.get('clicks:total')) || '0', 10) || 0;
      const today = parseInt((await env.CLICKS.get(todayKey())) || '0', 10) || 0;
      return new Response(
        JSON.stringify({ total, today, date: new Date().toISOString().slice(0, 10) }, null, 2),
        { headers: { 'content-type': 'application/json; charset=utf-8' } },
      );
    }

    if (url.pathname === '/' || url.pathname === '') {
      // Count without blocking the redirect.
      ctx.waitUntil(Promise.all([
        bump(env.CLICKS, 'clicks:total'),
        bump(env.CLICKS, todayKey()),
      ]));
      return Response.redirect(REFERRAL_TARGET, 302);
    }

    return new Response('Not found', { status: 404 });
  },
};
