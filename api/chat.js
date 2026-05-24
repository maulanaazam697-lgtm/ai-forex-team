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

// Strip JSON wrapper if AI accidentally returns JSON
function extractText(raw) {
  if (!raw) return '';
  let s = String(raw).trim();
  // remove markdown code fence
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  // If looks like JSON, try to extract meaningful text from common fields
  if (s.startsWith('{')) {
    try {
      const obj = JSON.parse(s);
      // try common reply fields
      return obj.reply || obj.response || obj.text || obj.message || obj.greeting ||
             obj.answer || Object.values(obj).filter(v => typeof v === 'string').join(' ') ||
             s;
    } catch {
      // not valid JSON, return as is
    }
  }
  return s;
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

    const contextLine = `Konteks kamu saat ini: equity $${equity.toFixed(2)} (return ${((equity-10000)/100).toFixed(2)}%), ${totalTrades} trade selesai, ${winRate}% win rate, ${openTrades?.length || 0} posisi terbuka.`;

    // IMPORTANT: Different system prompt for CHAT (no JSON formatting)
    const chatSystemPrompt = `${trader.system_prompt.replace(/Respond in JSON.*$/i, '').trim()}

PENTING UNTUK CHAT:
- Jawab dalam Bahasa Indonesia
- JANGAN gunakan format JSON
- Jawab maksimal 2 kalimat dalam teks biasa
- Tetap dalam karakter ${trader.name}
- Jangan kasih tanda kurung kurawal, langsung teks saja`;

    const userPrompt = `${contextLine}\n\nUser bertanya: "${message}"\n\nJawab langsung dalam teks biasa (BUKAN JSON), maksimal 2 kalimat:`;

    const rawReply = await callAI(trader.ai_provider, trader.ai_model, chatSystemPrompt, userPrompt);
    const cleanReply = extractText(rawReply);

    return res.status(200).json({
      trader: trader.name,
      emoji: trader.emoji,
      reply: cleanReply
    });
  } catch (err) {
    console.error('chat error:', err);
    return res.status(500).json({ error: err.message });
  }
}
