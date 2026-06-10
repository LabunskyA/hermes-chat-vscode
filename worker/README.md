# Referral Redirect Worker

A tiny Cloudflare Worker that 302-redirects to your Ace Data Cloud referral link
while counting clicks. This gives you the one metric the Ace Data dashboard does
**not** provide: how many people clicked, vs. how many actually registered.

```
Extension button → this Worker (counts a click) → 302 → share.acedata.cloud/r/1uN9UXvGv7
```

The redirect is a pure HTTP 302, so Ace Data's referral attribution cookie is set
exactly as if the user had clicked the original link — binding still works normally.

## What it tracks

- **Total clicks** (and per-day counts) in a KV namespace.
- Visit `/stats` on the Worker to see the JSON counters.
- The redirect itself lives at the Worker root `/`.

No personal data is stored — only aggregate counters.

## One-time setup

You need a free Cloudflare account.

1. Install Wrangler and log in:

   ```bash
   npm install -g wrangler
   wrangler login
   ```

2. Create the KV namespace used for counters:

   ```bash
   cd worker
   wrangler kv namespace create CLICKS
   ```

   Wrangler prints an `id`. Paste it into `wrangler.toml` under
   `[[kv_namespaces]]` → `id`.

3. (Optional) protect `/stats` with a token. Set a secret:

   ```bash
   wrangler secret put STATS_TOKEN
   ```

   Then call stats as `/stats?token=YOUR_TOKEN`.

4. Deploy:

   ```bash
   wrangler deploy
   ```

   Wrangler prints your Worker URL, e.g.
   `https://hermes-referral.<your-subdomain>.workers.dev`.

## After deploy

- Redirect URL to put in the extension: the Worker root, e.g.
  `https://hermes-referral.<your-subdomain>.workers.dev`
- Click stats: `https://hermes-referral.<your-subdomain>.workers.dev/stats`

Give me that Worker root URL and I'll swap it into the extension's `REFERRAL_URL`,
bump the version, and publish.

## Funnel you'll get

| Stage | Source |
|-------|--------|
| Clicks | this Worker's `/stats` |
| Registrations (Invitees) | Ace Data → Referral Earnings |
| Spend / reward | Ace Data → Referral Earnings |
