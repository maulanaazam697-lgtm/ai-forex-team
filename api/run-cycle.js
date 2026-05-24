// ============================================
// POST /api/run-cycle
// Main AI trading loop
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
  await sb.from('news_cache').delete().neq('id', 0);
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
    .filter(n => (n.affected_pairs || []).some(p => trader.preferred_pairs.includes(p)))
    .slice(0, 3);
  const newsTxt = relevantNews.length
    ? relevantNews.map(n => `- [${(n.sentiment||'neutral').toUpperCase()}] ${n.title}`).join('\n')
    : '(no major news right now)';
  const pricesTxt = trader.preferred_pairs
    .map(p => `- ${p}: ${(prices[p] || 0).toFixed(PAIRS[p].decimals)}`)
    .join('\n');
  return { newsTxt, pricesTxt };
}

export default async function handler(req, res) {
  const startTime = Date.now();
  try {
    const sb = getSupabase();

    // === STEP 1: Fetch forex prices (with detailed error) ===
    let prices;
    try {
      prices = await fetchForexPrices();
    } catch (fetchErr) {
      console.error('fetchForexPrices failed:', fetchErr);
      // Use fallback prices instead of failing entire cycle
      console.warn('Using fallback prices');
      prices = {
        'EUR/USD': 1.085, 'GBP/USD': 1.263, 'USD/JPY': 149.82,
        'AUD/USD': 0.658, 'USD/CAD': 1.357, 'EUR/JPY': 162.53
      };
    }

    if (!prices || Object.keys(prices).length === 0) {
      return res.status(500).json({ error: 'Could not get any forex prices' });
    }

    // === STEP 2: Refresh news ===
    let news;
    try {
      if (Math.random() < 0.3) {
        news = await refreshNews(sb);
      } else {
        const { data } = await sb.from('news_cache').select('*').limit(10);
        news = data || [];
        // If empty (first run), seed news
        if (news.length === 0) news = await refreshNews(sb);
      }
    } catch (newsErr) {
      console.warn('News error:', newsErr.message);
      news = [];
    }

    // === STEP 3: Get traders & open trades ===
    const [{ data: traders, error: trErr }, { data: openTrades, error: otErr }] = await Promise.all([
      sb.from('traders').select('*').order('id'),
      sb.from('trades').select('*').eq('status', 'OPEN')
    ]);
    if (trErr) throw new Error('Traders fetch: ' + trErr.message);
    if (otErr) throw new Error('Open trades fetch: ' + otErr.message);

    const log = [];

    // === STEP 4: Process each trader ===
    for (const trader of traders) {
      try {
        const myOpen = openTrades.filter(t => t.trader_id === trader.id);
        const myOpenPnL = myOpen.reduce((s, t) => s + computePnL(t, prices[t.pair] || t.entry_price), 0);
        const equity = parseFloat(trader.balance) + myOpenPnL;

        const { newsTxt, pricesTxt } = buildMarketContext(prices, news, trader);
        const openTxt = myOpen.length
          ? myOpen.map(t => `- ${t.pair} ${t.action} ${t.lot_size} lot @ ${t.entry_price} (now ${prices[t.pair]?.toFixed(PAIRS[t.pair].decimals)}, PnL: $${computePnL(t, prices[t.pair]).toFixed(2)})`).join('\n')
          : '(no open positions)';

        const userPrompt = `Current forex prices:\n${pricesTxt}\n\nLatest news:\n${newsTxt}\n\nYour current open positions:\n${openTxt}\n\nYour balance: $${parseFloat(trader.balance).toFixed(2)}, Equity: $${equity.toFixed(2)}\n\nDecide your next action. Reply ONLY in JSON: {"action":"BUY|SELL|CLOSE|HOLD","reasoning":"why","confidence":0-100,"pair":"EUR/USD"}\n\nIf BUY/SELL: choose pair from (${trader.preferred_pairs.join(', ')}).\nIf CLOSE: specify which pair to close.`;

        let responseText;
        try {
          responseText = await callAI(trader.ai_provider, trader.ai_model, trader.system_prompt, userPrompt);
        } catch (aiErr) {
          log.push({ trader: trader.name, status: 'ai_error', error: aiErr.message.slice(0, 200) });
          continue;
        }

        const decision = parseAIDecision(responseText);
        if (!decision) {
          log.push({ trader: trader.name, status: 'invalid_response', raw: responseText?.slice(0, 200) });
          continue;
        }

        const pair = decision.pair;

        // === HANDLE CLOSE ===
        if (decision.action === 'CLOSE' && myOpen.length > 0) {
          const target = pair
            ? myOpen.find(t => t.pair === pair)
            : myOpen[0];
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
          } else {
            log.push({ trader: trader.name, status: 'close_no_match' });
          }
        }
        // === HANDLE BUY/SELL ===
        else if ((decision.action === 'BUY' || decision.action === 'SELL') && myOpen.length < 3) {
          const occupied = myOpen.map(t => t.pair);
          let chosenPair = pair && trader.preferred_pairs.includes(pair) && !occupied.includes(pair)
            ? pair
            : trader.preferred_pairs.find(p => !occupied.includes(p));
          if (!chosenPair) {
            log.push({ trader: trader.name, action: 'SKIP', reason: 'no available pair' });
            continue;
          }

          const lotByTrader = { 1: 0.15, 2: 0.05, 3: 0.10, 4: 0.12, 5: 0.40 };
          const lot = lotByTrader[trader.id] || 0.1;

          const newsContext = trader.id === 3
            ? news.filter(n => (n.affected_pairs || []).includes(chosenPair)).slice(0,2).map(n => n.title).join(' | ')
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

        // === Record equity snapshot ===
        try {
          const { data: newOpenTrades } = await sb.from('trades').select('*').eq('trader_id', trader.id).eq('status', 'OPEN');
          const newOpenPnL = (newOpenTrades || []).reduce((s, t) => s + computePnL(t, prices[t.pair] || t.entry_price), 0);
          const { data: updatedTrader } = await sb.from('traders').select('balance').eq('id', trader.id).single();
          const newEquity = parseFloat(updatedTrader.balance) + newOpenPnL;
          await sb.from('equity_snapshots').insert({ trader_id: trader.id, equity: newEquity });
        } catch (snapErr) {
          console.warn('Snapshot error for', trader.name, ':', snapErr.message);
        }
      } catch (traderErr) {
        log.push({ trader: trader.name, status: 'error', error: traderErr.message.slice(0, 200) });
      }
    }

    return res.status(200).json({
      ok: true,
      cycle_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      prices,
      log
    });
  } catch (err) {
    console.error('run-cycle fatal error:', err);
    return res.status(500).json({
      error: err.message,
      where: 'run-cycle handler',
      duration_ms: Date.now() - startTime
    });
  }
}
