// ============================================
// GET /api/get-data
// ============================================
import { getSupabase, fetchForexPrices, computePnL, PAIRS } from './_lib.js';

export default async function handler(req, res) {
  try {
    const sb = getSupabase();

    // Get prices (uses global cache automatically)
    let prices = {};
    try {
      prices = await fetchForexPrices();
    } catch (err) {
      console.warn('Price fetch failed in get-data:', err.message);
      // Don't fail entire request — return empty prices
      prices = {};
    }

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

    // Use entry_price as fallback if no current price available
    const getPriceFor = (pair, entry) => prices[pair] || parseFloat(entry);

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

    const enrichedOpen = openTrades.map(t => {
      const currentPrice = getPriceFor(t.pair, t.entry_price);
      return {
        ...t,
        current_price: currentPrice,
        live_pnl: computePnL(t, currentPrice)
      };
    });

    const equityByTrader = {};
    for (const s of snapshots) {
      if (!equityByTrader[s.trader_id]) equityByTrader[s.trader_id] = [];
      equityByTrader[s.trader_id].push({ equity: parseFloat(s.equity), at: s.recorded_at });
    }
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
