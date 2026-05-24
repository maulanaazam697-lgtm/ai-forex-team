// ============================================
// POST /api/run-cycle
// Main AI trading loop:
//   1. Fetch forex prices
//   2. For each trader: close some positions, open new ones via AI
//   3. Record equity snapshot
// Called by cron-job.org every 15 minutes
// ============================================
import { getSupabase, fetchForexPrices, computePnL, callAI, parseAIDecision, PAIRS } from './_lib.js';

const NEWS_POOL = [
  { title: "ECB hints at potential rate cut amid slowing inflation", sentiment: 'bearish', source: 'Reuters', affected_pairs: ['EUR/USD','EUR/JPY'] },
  { title: "US NFP beats expectations: dollar strengthens", sentiment: 'bullish', source: 'Bloomberg', affected_pairs: ['EUR/USD','GBP/USD','AUD/USD','USD/JPY','USD/CAD'] },
  { title: "Eurozone PMI rises, manufacturing recovery", sentiment: 'bullish', source: 'FT', affected_pairs: ['EUR/USD','EUR/JPY'] },
  { title: "Fed Chair: 'Patient approach' to rate decisions", sentiment: 'neutral', source: 'CNBC', affected_pairs: ['EUR/USD','USD/JPY'] },
  { title: "BoJ unlikely to hike rates, JPY remains weak", sentiment: 'bearish', source: 'Nikkei', affected_pairs: ['USD/JPY','EUR/JPY'] },
  { title: "BoE keeps rates unchanged, GBP volatile", sentiment: 'neutral', source: 'BBC', affected_pairs: ['GBP/USD'] },
  { title: "US CPI cools, market expects pause in hikes", sentiment: 'bearish', source: 'WSJ', affected_pairs: ['EUR/USD','USD/JPY'] },
  { title: "Dollar index hits high on hawkish Fed minutes", sentiment: 'bullish', source: 'Bloomberg', affected_pairs: ['EUR/USD','GBP/USD','AUD/USD','USD/CAD'] }
];

async function refreshNews(sb) {
  // Pick 4 random news, replace cache
  await sb.from('news_cache').delete().neq('id', 0); // clear all
  const picked = [];
  const pool = [...NEWS_POOL];
  for (let i = 0; i < 4 && pool.length; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    picked.push(pool.splice(idx, 1)[0]);
  }
  if (picked.length) {
    await sb.from('news_cache').insert(picked);
  }
  return picked;
}

function buildMarketContext(prices, news, trader) {
  const relevantNews = news
    .filter(n => n.affected_pairs.some(p => trader.preferred_pairs.includes(p)))
    .slice(0, 3);
  const newsTxt = relevantNews.length
    ? relevantNews.map(n => `- [${n.sentiment.toUpperCase()}] ${n.title}`).join('\n')
    : '(no major news right now)';
  const pricesTxt = trader.preferred_pairs
    .map(p => `- ${p}: ${prices[p]?.toFixed(PAIRS[p].decimals)}`)
    .join('\n');
  return { newsTxt, pricesTxt };
}

export default async function handler(req, res) {
  try {
    const sb = getSupabase();
    const prices = await fetchForexPrices();
    if (!prices || Object.keys(prices).length === 0) {
      throw new Error('Failed to fetch forex prices');
    }

    // Refresh news once per cycle (30% chance)
    let news;
    if (Math.random() < 0.3) {
      news = await refreshNews(sb);
    } else {
      const { data } = await sb.from('news_cache').select('*').limit(10);
      news = data || [];
    }

    // Get all traders & open trades
    const [{ data: traders }, { data: openTrades }] = await Promise.all([
      sb.from('traders').select('*').order('id'),
      sb.from('trades').select('*').eq('status', 'OPEN')
    ]);

    const log = [];

    for (const trader of traders) {
      try {
        const myOpen = openTrades.filter(t => t.trader_id === trader.id);
        const myOpenPnL = myOpen.reduce((s, t) => s + computePnL(t, prices[t.pair] || t.entry_price), 0);
        const equity = parseFloat(trader.balance) + myOpenPnL;

        const { newsTxt, pricesTxt } = buildMarketContext(prices, news, trader);
        const openTxt = myOpen.length
          ? myOpen.map(t => `- ${t.pair} ${t.action} ${t.lot_size} lot @ ${t.entry_price} (now ${prices[t.pair]?.toFixed(PAIRS[t.pair].decimals)}, PnL: $${computePnL(t, prices[t.pair]).toFixed(2)})`).join('\n')
          : '(no open positions)';

        // Build user prompt for AI
        const userPrompt = `Current forex prices:\n${pricesTxt}\n\nLatest news:\n${newsTxt}\n\nYour current open positions:\n${openTxt}\n\nYour balance: $${trader.balance.toFixed(2)}, Equity: $${equity.toFixed(2)}\n\nDecide your next action. Reply ONLY in JSON: {"action":"BUY|SELL|CLOSE|HOLD","reasoning":"why","confidence":0-100,"pair":"EUR/USD"}\n\nIf BUY/SELL: which pair from your preferred list (${trader.preferred_pairs.join(', ')})?\nIf CLOSE: which open position to close (specify pair)?`;

        const responseText = await callAI(trader.ai_provider, trader.ai_model, trader.system_prompt, userPrompt);
        const decision = parseAIDecision(responseText);

        if (!decision) {
          log.push({ trader: trader.name, status: 'invalid_response', raw: responseText?.slice(0, 200) });
          continue;
        }

        // Try parse pair from response
        let pair = null;
        try {
          const obj = JSON.parse(responseText.match(/\{[\s\S]*\}/)?.[0] || '{}');
          pair = obj.pair;
        } catch {}

        // === HANDLE CLOSE ===
        if (decision.action === 'CLOSE' && myOpen.length > 0) {
          // Find which position to close
          const target = pair
            ? myOpen.find(t => t.pair === pair)
            : myOpen[0]; // close first if not specified
          if (target) {
            const pnl = computePnL(target, prices[target.pair]);
            await sb.from('trades').update({
              status: 'CLOSED',
              exit_price: prices[target.pair],
              pnl,
              closed_at: new Date().toISOString()
            }).eq('id', target.id);

            await sb.from('traders').update({
              balance: parseFloat(trader.balance) + pnl,
              wins: trader.wins + (pnl > 0 ? 1 : 0),
              losses: trader.losses + (pnl <= 0 ? 1 : 0)
            }).eq('id', trader.id);

            log.push({ trader: trader.name, action: 'CLOSE', pair: target.pair, pnl: pnl.toFixed(2), reason: decision.reasoning });
            continue;
          }
        }

        // === HANDLE BUY / SELL ===
        if ((decision.action === 'BUY' || decision.action === 'SELL') && myOpen.length < 3) {
          // Pick pair (validate it's in preferred_pairs and not already occupied)
          const occupied = myOpen.map(t => t.pair);
          let chosenPair = pair && trader.preferred_pairs.includes(pair) && !occupied.includes(pair)
            ? pair
            : trader.preferred_pairs.find(p => !occupied.includes(p));
          if (!chosenPair) {
            log.push({ trader: trader.name, action: 'SKIP', reason: 'no available pair' });
            continue;
          }

          // Lot size based on trader risk profile
          const lotByTrader = { 1: 0.15, 2: 0.05, 3: 0.10, 4: 0.12, 5: 0.40 };
          const lot = lotByTrader[trader.id] || 0.1;

          const newsContext = trader.id === 3
            ? news.filter(n => n.affected_pairs.includes(chosenPair)).slice(0,2).map(n => n.title).join(' | ')
            : null;

          await sb.from('trades').insert({
            trader_id: trader.id,
            pair: chosenPair,
            action: decision.action,
            entry_price: prices[chosenPair],
            lot_size: lot,
            reasoning: decision.reasoning,
            news_context: newsContext,
            status: 'OPEN'
          });

          log.push({ trader: trader.name, action: decision.action, pair: chosenPair, lot, reason: decision.reasoning });
        } else {
          log.push({ trader: trader.name, action: 'HOLD', reason: decision.reasoning });
        }

        // Record equity snapshot
        const newOpenTrades = await sb.from('trades').select('*').eq('trader_id', trader.id).eq('status', 'OPEN');
        const newOpenPnL = (newOpenTrades.data || []).reduce((s, t) => s + computePnL(t, prices[t.pair] || t.entry_price), 0);
        const { data: updatedTrader } = await sb.from('traders').select('balance').eq('id', trader.id).single();
        const newEquity = parseFloat(updatedTrader.balance) + newOpenPnL;
        await sb.from('equity_snapshots').insert({
          trader_id: trader.id,
          equity: newEquity
        });

      } catch (traderErr) {
        log.push({ trader: trader.name, status: 'error', error: traderErr.message });
      }
    }

    return res.status(200).json({
      ok: true,
      cycle_at: new Date().toISOString(),
      prices,
      log
    });
  } catch (err) {
    console.error('run-cycle error:', err);
    return res.status(500).json({ error: err.message, stack: err.stack });
  }
}
