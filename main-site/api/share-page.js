// What a share link opens for anyone without the app's service worker yet, chat apps' link previews
// included: /go/<id>, /trip/<id>, /eta/<id> and /list/<id> come here (vercel.json). It gives the
// preview its title and picture, and sends a person on to the app.

import { supabaseConfigured } from './_lib/supabase.js';
import { PATHS, describeLink, getLink, isLinkId } from './_lib/share-links.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export default async function handler(req, res) {
  const { id } = req.query;
  const origin = `https://${req.headers['x-forwarded-host'] || req.headers.host || 'maps.uwuapps.org'}`;
  let link = null;
  if (isLinkId(id) && supabaseConfigured()) {
    try {
      link = await getLink(id);
    } catch (err) {
      console.error(err);
    }
  }

  // The app shows that a link has gone, and its address stays readable to it through the hash.
  const target = isLinkId(id) ? `/#share/${id}` : '/';
  const { title, description } = link
    ? describeLink(link)
    : { title: 'uwuMaps', description: 'Explore cities in colourful 3D and find your way on foot, by bike or by car.' };
  const image = link ? `${origin}/api/share-map?id=${id}${link.kind === 'eta' ? `&v=${link.updatedAt}` : ''}` : `${origin}/MAP-main.png`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', link?.kind === 'eta' || !link ? 'no-store' : 'public, max-age=300, s-maxage=86400');
  res.status(link || !isLinkId(id) ? 200 : 404).send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="robots" content="noindex">
<meta property="og:type" content="website">
<meta property="og:site_name" content="uwuMaps">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(link ? `${origin}/${PATHS[link.kind]}/${id}` : origin)}">
<meta property="og:image" content="${esc(image)}">
${link ? '<meta property="og:image:width" content="1024">\n<meta property="og:image:height" content="512">\n<meta name="twitter:card" content="summary_large_image">' : '<meta name="twitter:card" content="summary">'}
<script>location.replace(${JSON.stringify(target)});</script>
</head>
<body>
<p><a href="${esc(target)}">Open in uwuMaps</a></p>
</body>
</html>
`);
}
