// Supabase, over its REST API with plain fetch. Only these functions reach it, with the service role
// (or secret) key. The tables have row level security on and no policies, so the public anon key gets
// nothing.

const BASE = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;

export const supabaseConfigured = () => Boolean(BASE && KEY);

// `path` is the table and its query, as PostgREST takes them: "uwumaps_sync?code_hash=eq.abc".
// Answers the parsed body, or null for an empty one.
export async function rest(path, { method = 'GET', body, prefer } = {}) {
  const res = await fetch(`${BASE}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: KEY,
      // The older service_role key is a JWT and goes here too; a newer sb_secret_ key is refused
      // as a bearer token, and the apikey header alone carries it.
      ...(KEY.startsWith('eyJ') && { Authorization: `Bearer ${KEY}` }),
      'Content-Type': 'application/json',
      ...(prefer && { Prefer: prefer }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // Left null.
  }
  if (!res.ok) {
    const err = new Error(`supabase ${method} ${path.split('?')[0]} failed: ${data?.message ?? res.status}`);
    err.status = res.status;
    err.code = data?.code;
    throw err;
  }
  return data;
}
