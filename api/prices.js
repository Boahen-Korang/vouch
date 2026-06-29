let cache = null;
let cacheTime = 0;
const TTL = 60000;

const FALLBACK = { BTC: 67200, ETH: 2418, USDT: 1.0, SOL: 148 };

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=60');
  if (req.method !== 'GET') return res.status(405).end();

  const now = Date.now();
  if (cache && now - cacheTime < TTL) return res.status(200).json(cache);

  try {
    const r = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,tether,solana&vs_currencies=usd',
      { headers: { 'Accept': 'application/json' } }
    );
    if (!r.ok) throw new Error('CoinGecko ' + r.status);
    const d = await r.json();
    cache = {
      BTC:  d.bitcoin?.usd  || FALLBACK.BTC,
      ETH:  d.ethereum?.usd || FALLBACK.ETH,
      USDT: d.tether?.usd   || FALLBACK.USDT,
      SOL:  d.solana?.usd   || FALLBACK.SOL,
    };
    cacheTime = now;
    res.status(200).json(cache);
  } catch (e) {
    res.status(200).json(cache || FALLBACK);
  }
};
