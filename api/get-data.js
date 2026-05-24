// ============================================
// GET /api/get-data
// Returns: traders, open trades, recent closed trades,
//          equity history, latest prices
// ============================================
import { getSupabase, fetchForexPrices, computePnL, PAIRS } from './_lib.js';

let priceCache = { prices: null, timestamp: 0 };

async function getPricesWithCache() {
  const now = Date.now();
  if (priceCache.prices && now - priceCache.timestamp < 60_000) {
    return priceCache.prices;
  }
  try {
    const prices = await fetchForexPrices();
    priceCache = { prices, timestamp: now };
    return prices;
  } catch (err) {
    // fallback: return last known prices, or defaults
    if (priceCache.prices) return priceCache.prices;
    return {
      'EUR/USD': 1.085, 'GBP/USD': 1.263, 'USD/JPY': 149.82,
      'AUD/USD': 0.658, 'USD/CAD': 1.357, 'EUR/JPY': 162.53
    };
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

    // Compute equity per trader (balance + open PnL)
    const enrichedTraders = traders.map(t => {
      const myOpen = openTrades.filter(o => o.trader_id === t.id);
      const openPnL = myOpen.reduce((sum, tr) => sum + computePnL(tr, prices[tr.pair] || tr.entry_price), 0);
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
    const enrichedOpen = openTrades.map(t => ({
      ...t,
      current_price: prices[t.pair] || t.entry_price,
      live_pnl: computePnL(t, prices[t.pair] || t.entry_price)
    }));

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
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('get-data error:', err);
    return res.status(500).json({ error: err.message });
  }
}
