// ============================================
// SHARED LIBRARY - dipakai semua API routes
// ============================================
import { createClient } from '@supabase/supabase-js';

// === SUPABASE CLIENT ===
export function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('Missing Supabase env vars');
  return createClient(url, key);
}

// === FOREX PAIRS CONFIG ===
export const PAIRS = {
  'EUR/USD': { decimals: 5, pip: 0.0001 },
  'GBP/USD': { decimals: 5, pip: 0.0001 },
  'USD/JPY': { decimals: 3, pip: 0.01 },
  'AUD/USD': { decimals: 5, pip: 0.0001 },
  'USD/CAD': { decimals: 5, pip: 0.0001 },
  'EUR/JPY': { decimals: 3, pip: 0.01 }
};

// === FETCH FOREX PRICE FROM TWELVEDATA (robust + fallback) ===
export async function fetchForexPrices() {
  const key = process.env.TWELVEDATA_API_KEY;
  if (!key) throw new Error('Missing TwelveData API key');

  const symbols = Object.keys(PAIRS).join(',');
  const url = `https://api.twelvedata.com/price?symbol=${encodeURIComponent(symbols)}&apikey=${key}`;

  let data;
  try {
    const res = await fetch(url);
    data = await res.json();
  } catch (err) {
    throw new Error('Network error to TwelveData: ' + err.message);
  }

  // Check for API error (rate limit, invalid key, etc)
  if (data.code && data.code !== 200) {
    throw new Error(`TwelveData error ${data.code}: ${data.message || 'unknown'}`);
  }
  if (data.status === 'error') {
    throw new Error(`TwelveData: ${data.message || 'unknown error'}`);
  }

  // Parse response — multi-symbol returns { "EUR/USD": {"price":"..."} }
  //                  single symbol returns { "price":"..." }
  const prices = {};
  for (const sym of Object.keys(PAIRS)) {
    if (data[sym] && data[sym].price) {
      prices[sym] = parseFloat(data[sym].price);
    }
  }

  // Fallback for single-symbol response shape
  if (Object.keys(prices).length === 0 && data.price) {
    // shouldn't happen with multi-symbol, but just in case
    const firstPair = Object.keys(PAIRS)[0];
    prices[firstPair] = parseFloat(data.price);
  }

  // If still empty, return fallback static prices (so app doesn't break)
  if (Object.keys(prices).length === 0) {
    console.warn('TwelveData returned no prices, using fallback');
    return {
      'EUR/USD': 1.085, 'GBP/USD': 1.263, 'USD/JPY': 149.82,
      'AUD/USD': 0.658, 'USD/CAD': 1.357, 'EUR/JPY': 162.53
    };
  }

  // Fill in missing pairs with fallback
  const fallback = {
    'EUR/USD': 1.085, 'GBP/USD': 1.263, 'USD/JPY': 149.82,
    'AUD/USD': 0.658, 'USD/CAD': 1.357, 'EUR/JPY': 162.53
  };
  for (const sym of Object.keys(PAIRS)) {
    if (!prices[sym]) prices[sym] = fallback[sym];
  }

  return prices;
}

// === COMPUTE PNL FROM OPEN POSITION ===
export function computePnL(trade, currentPrice) {
  const pair = PAIRS[trade.pair];
  if (!pair) return 0;
  const diff = (currentPrice - trade.entry_price) * (trade.action === 'BUY' ? 1 : -1);
  const pipValue = trade.pair.endsWith('JPY') ? 1000 : 10000;
  return (diff / pair.pip) * trade.lot_size * (pair.pip * pipValue);
}

// === CALL AI PROVIDERS ===
export async function callAI(provider, model, systemPrompt, userPrompt) {
  if (provider === 'groq') return callGroq(model, systemPrompt, userPrompt);
  if (provider === 'gemini') return callGemini(model, systemPrompt, userPrompt);
  if (provider === 'openrouter') return callOpenRouter(model, systemPrompt, userPrompt);
  throw new Error(`Unknown AI provider: ${provider}`);
}

async function callGroq(model, system, user) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('Missing GROQ_API_KEY');
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      temperature: 0.7,
      max_tokens: 300,
      response_format: { type: 'json_object' }
    })
  });
  const data = await res.json();
  if (data.error) throw new Error('Groq: ' + (data.error.message || JSON.stringify(data.error)));
  return data.choices[0].message.content;
}

async function callGemini(model, system, user) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('Missing GEMINI_API_KEY');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ parts: [{ text: user }] }],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 300,
        responseMimeType: 'application/json'
      }
    })
  });
  const data = await res.json();
  if (data.error) throw new Error('Gemini: ' + (data.error.message || JSON.stringify(data.error)));
  if (!data.candidates || !data.candidates[0]) throw new Error('Gemini: no candidates in response');
  return data.candidates[0].content.parts[0].text;
}

async function callOpenRouter(model, system, user) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('Missing OPENROUTER_API_KEY');
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://ai-forex-team.vercel.app',
      'X-Title': 'AI Forex Team'
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      temperature: 0.7,
      max_tokens: 300
    })
  });
  const data = await res.json();
  if (data.error) throw new Error('OpenRouter: ' + (data.error.message || JSON.stringify(data.error)));
  if (!data.choices || !data.choices[0]) throw new Error('OpenRouter: no choices in response');
  return data.choices[0].message.content;
}

// === PARSE AI JSON RESPONSE (robust) ===
export function parseAIDecision(text) {
  if (!text) return null;
  let cleaned = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]);
    const action = String(obj.action || 'HOLD').toUpperCase();
    if (!['BUY','SELL','CLOSE','HOLD'].includes(action)) return null;
    return {
      action,
      reasoning: String(obj.reasoning || 'No reasoning').slice(0, 300),
      confidence: Math.max(0, Math.min(100, parseInt(obj.confidence) || 50)),
      pair: obj.pair ? String(obj.pair) : null
    };
  } catch {
    return null;
  }
}
