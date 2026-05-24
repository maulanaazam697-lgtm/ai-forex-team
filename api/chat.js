// ============================================
// POST /api/chat
// Body: { trader_id: 1, message: "hi how are you?" }
// Returns: { reply: "..." }
// ============================================
import { getSupabase, callAI, fetchForexPrices, computePnL } from './_lib.js';

let priceCache = { prices: null, timestamp: 0 };

async function getPricesWithCache() {
  const now = Date.now();
  if (priceCache.prices && now - priceCache.timestamp < 60_000) return priceCache.prices;
  try {
    const prices = await fetchForexPrices();
    priceCache = { prices, timestamp: now };
    return prices;
  } catch {
    return priceCache.prices || {};
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const { trader_id, message } = req.body || {};
    if (!trader_id || !message) {
      return res.status(400).json({ error: 'Missing trader_id or message' });
    }

    const sb = getSupabase();
    const { data: trader, error: traderErr } = await sb.from('traders').select('*').eq('id', trader_id).single();
    if (traderErr || !trader) return res.status(404).json({ error: 'Trader not found' });

    // Get current context
    const prices = await getPricesWithCache();
    const { data: openTrades } = await sb.from('trades').select('*').eq('trader_id', trader_id).eq('status', 'OPEN');
    const openPnL = (openTrades || []).reduce((s, t) => s + computePnL(t, prices[t.pair] || t.entry_price), 0);
    const equity = parseFloat(trader.balance) + openPnL;
    const totalTrades = trader.wins + trader.losses;
    const winRate = totalTrades > 0 ? (trader.wins / totalTrades * 100).toFixed(0) : 0;

    const contextLine = `[Your stats: equity $${equity.toFixed(2)} (${((equity-10000)/100).toFixed(2)}% return), ${totalTrades} trades, ${winRate}% win rate, ${openTrades?.length || 0} open positions]`;

    const userPrompt = `${contextLine}\n\nUser asks: "${message}"\n\nReply in a casual conversational way (NOT JSON), max 2 sentences, in Bahasa Indonesia. Stay in character as ${trader.name}.`;

    // Use a chat-friendly system prompt (drop JSON formatting requirement)
    const chatSystemPrompt = trader.system_prompt
      .replace(/Respond in JSON.*$/i, '')
      .trim() + `\n\nWhen chatting with users, respond conversationally (no JSON), max 2 sentences, in Bahasa Indonesia.`;

    const reply = await callAI(trader.ai_provider, trader.ai_model, chatSystemPrompt, userPrompt);

    return res.status(200).json({
      trader: trader.name,
      emoji: trader.emoji,
      reply: reply.trim()
    });
  } catch (err) {
    console.error('chat error:', err);
    return res.status(500).json({ error: err.message });
  }
}
