// Share links:
//
//   POST  { kind, data }          { id, path, secret? }      a link, made or found again
//   GET   ?id=                    { kind, data, updatedAt }  what a link holds
//   PATCH { id, secret, data }    204                        an ETA link's new progress

import { supabaseConfigured } from './_lib/supabase.js';
import { overLimit } from './_lib/rate.js';
import { PATHS, ValidationError, createLink, getLink, isLinkId, parseLink, updateEta } from './_lib/share-links.js';

// Making links is rarer than following them: an ETA updates a few times a minute.
const CREATE_PER_MINUTE = 20;
const UPDATE_PER_MINUTE = 30;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!supabaseConfigured()) return res.status(503).json({ error: "Short links aren't set up on this site" });

  try {
    if (req.method === 'GET') {
      const { id } = req.query;
      if (!isLinkId(id)) return res.status(400).json({ error: 'bad id' });
      const link = await getLink(id);
      if (!link) return res.status(404).json({ error: 'No such link' });
      return res.status(200).json({ kind: link.kind, data: link.data, updatedAt: link.updatedAt });
    }

    if (req.method === 'POST') {
      if (await overLimit(req, 'share', CREATE_PER_MINUTE)) return res.status(429).json({ error: 'Too many links. Try again in a minute.' });
      const { kind } = req.body || {};
      if (!Object.hasOwn(PATHS, kind)) return res.status(400).json({ error: 'bad kind' });
      const data = parseLink(kind, req.body.data);
      const { id, secret } = await createLink(kind, data);
      return res.status(200).json({ id, path: `/${PATHS[kind]}/${id}`, ...(secret && { secret }) });
    }

    if (req.method === 'PATCH') {
      if (await overLimit(req, 'eta', UPDATE_PER_MINUTE)) return res.status(429).json({ error: 'Too many updates' });
      const { id, secret } = req.body || {};
      if (!isLinkId(id)) return res.status(400).json({ error: 'bad id' });
      const data = parseLink('eta', req.body.data);
      const updated = await updateEta(id, secret, data);
      return updated ? res.status(204).end() : res.status(404).json({ error: 'No such link' });
    }

    return res.status(405).json({ error: 'GET, POST or PATCH' });
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    console.error(err);
    return res.status(500).json({ error: "Couldn't do that just now" });
  }
}
