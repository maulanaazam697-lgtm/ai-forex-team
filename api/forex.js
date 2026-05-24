// ============================================
// GET /api/forex
// Returns current forex prices for all pairs
// ============================================
import { fetchForexPrices, PAIRS } from './_lib.js';

// Simple in-memory cache (per serverless instance)
let cache = { prices: null, timestamp: 0 };
const CACHE_TTL = 60_000; // 60 seconds

export default async function handler(req, res) {
  try {
    const now = Date.now();
    if (cache.prices && now - cache.timestamp < CACHE_TTL) {
      return res.status(200).json({
        prices: cache.prices,
        cached: true,
        age_seconds: Math.round((now - cache.timestamp)/1000)
      });
    }

    const prices = await fetchForexPrices();
    cache = { prices, timestamp: now };

    return res.status(200).json({
      prices,
      pairs: Object.keys(PAIRS),
      cached: false
    });
  } catch (err) {
    console.error('Forex error:', err);
    return res.status(500).json({ error: err.message });
  }
}
