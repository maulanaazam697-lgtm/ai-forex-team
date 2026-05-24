// ============================================
// GET /api/get-data
// Returns: traders, open trades, recent closed trades,
//          equity history, latest prices
// ============================================
import { getSupabase, fetchForexPrices, computePnL, PAIRS } from './_lib.js';

let priceCache = { prices: null, timestamp: 0 };

async function getPricesWithCache() {
  const now = Date.now();
  // Use cache if fresh (within 60s)
  if (priceCache.prices && now - priceCache.timestamp < 60_000) {
    return priceCache.prices;
  }
  try {
    const prices = await fetchForexPrices();
    priceCache = { prices, timestamp: now };
    return prices;
  } catch (err) {
    // If fetch fails, return cached (even if old) — better than fake fallback
    if (priceCache.prices) {
      console.warn('Using stale cache (fetch failed):', err.message);
      return priceCache.prices;
    }
    // No cache at all — return empty so frontend shows "..."
    console.warn('No prices available:', err.message);
    return {};
  }
}

export default async function handler(req, res) {
  try {
    const sb = getSupabase();
    const prices = await getPricesWithCache();

    // Fetch all data in parallel
    const [tradersRes, openTradesRes, closedTradesRes, snapshotsRes, newsRes] = await Promise.all([
      sb.from('traders').select('*').order('id'),
      sb.from('trades').select('*').eq('status', 'OPEN').order('opened_at', { ascending: false }),
      sb.from('trades').select('*').eq('status', 'CLOSED').order('closed_at', { ascending: false }).limit(100),
      sb.from('equity_snapshots').select('*').order('recorded_at', { ascending: false }).limit(500),
      sb.from('news_cache').select('*').order('published_at', { ascending: false }).limit(10)
    ]);

    if (tradersRes.error) throw tradersRes.error;

    const traders = tradersRes.data || [];
    const openTrades = openTradesRes.data || [];
    const closedTrades = closedTradesRes.data || [];
    const snapshots = snapshotsRes.data || [];
    const news = newsRes.data || [];

    // Helper: get price for pair, fallback to trade's entry price if no price available
    const getPriceFor = (pair, entry) => prices[pair] || parseFloat(entry);

    // Compute equity per trader (balance + open PnL using REAL prices when available)
    const enrichedTraders = traders.map(t => {
      const myOpen = openTrades.filter(o => o.trader_id === t.id);
      const openPnL = myOpen.reduce((sum, tr) => sum + computePnL(tr, getPriceFor(tr.pair, tr.entry_price)), 0);
      const equity = parseFloat(t.balance) + openPnL;
      const totalTrades = t.wins + t.losses;
      const winRate = totalTrades > 0 ? (t.wins / totalTrades * 100) : 0;
      return {
        ...t,
        open_pnl: openPnL,
        equity,
        return_pct: ((equity - 10000) / 10000) * 100,
        win_rate: winRate,
        total_trades: totalTrades,
        open_count: myOpen.length
      };
    });

    // Enrich open trades with current price & live PnL
    const enrichedOpen = openTrades.map(t => {
      const currentPrice = getPriceFor(t.pair, t.entry_price);
      return {
        ...t,
        current_price: currentPrice,
        live_pnl: computePnL(t, currentPrice)
      };
    });

    // Group snapshots by trader
    const equityByTrader = {};
    for (const s of snapshots) {
      if (!equityByTrader[s.trader_id]) equityByTrader[s.trader_id] = [];
      equityByTrader[s.trader_id].push({ equity: parseFloat(s.equity), at: s.recorded_at });
    }
    // reverse so chronological (oldest first)
    for (const id in equityByTrader) equityByTrader[id].reverse();

    return res.status(200).json({
      traders: enrichedTraders,
      open_trades: enrichedOpen,
      closed_trades: closedTrades,
      equity_history: equityByTrader,
      news,
      prices,
      pairs: Object.keys(PAIRS),
      prices_available: Object.keys(prices).length > 0,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('get-data error:', err);
    return res.status(500).json({ error: err.message });
  }
}
