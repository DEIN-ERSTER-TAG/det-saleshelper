require('dotenv').config();

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redisGet(key) {
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(['GET', key]),
  });
  const json = await res.json();
  return json.result ? JSON.parse(json.result) : [];
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (!REDIS_URL || !REDIS_TOKEN) {
    return res.status(503).json({ error: 'Redis nicht konfiguriert.' });
  }

  try {
    const [schulcards, praesentationen, angebote] = await Promise.all([
      redisGet('schulcards'),
      redisGet('praesentationen'),
      redisGet('angebote'),
    ]);

    const tagged = [
      ...schulcards.map(e => ({ ...e, _type: 'schulcard', _label: 'Schulcard', _url: 'https://schulcard-generator.vercel.app' })),
      ...praesentationen.map(e => ({ ...e, _type: 'praesentation', _label: 'Präsentation', _url: '#' })),
      ...angebote.map(e => ({ ...e, _type: 'angebot', _label: 'Angebot', _url: 'https://angebot-generator-pi.vercel.app' })),
    ].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

    return res.json({ items: tagged });
  } catch (err) {
    console.error('Dashboard error:', err);
    return res.status(500).json({ error: err.message });
  }
};
