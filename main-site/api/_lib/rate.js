// How many requests one address may make, kept in Supabase's uwumaps_rate_limits table. If the count
// can't be read, the request goes ahead: a limit shouldn't take the feature down with it.

import { rest } from './supabase.js';

const clientIp = (req) => req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';

export async function overLimit(req, scope, limit, windowSeconds = 60) {
  try {
    const count = await rest('rpc/uwumaps_bump_rate', {
      method: 'POST',
      body: { p_key: `${scope}:${clientIp(req)}`, window_seconds: windowSeconds },
    });
    return Number(count) > limit;
  } catch (err) {
    console.warn('rate limit:', err.message);
    return false;
  }
}
