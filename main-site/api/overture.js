// Which Overture Maps release to read online buildings from. Old releases get retired, so the address
// can't be fixed in the app. Answered from Overture's own catalogue, and kept for a day.

export default async function handler(req, res) {
  try {
    const upstream = await fetch('https://stac.overturemaps.org/catalog.json', { signal: AbortSignal.timeout(8000) });
    if (!upstream.ok) throw new Error(`The catalogue answered ${upstream.status}`);
    const { latest } = await upstream.json();
    if (!/^\d{4}-\d{2}-\d{2}\.\d+$/.test(String(latest))) throw new Error('The catalogue names no release');
    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400');
    return res.status(200).json({ release: latest });
  } catch (err) {
    console.warn('overture:', err.message);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({ error: "Couldn't read Overture's catalogue" });
  }
}
