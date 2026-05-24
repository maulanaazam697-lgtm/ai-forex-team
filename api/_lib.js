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

// === FETCH FOREX PRICE FROM TWELVEDATA ===
export async function fetchForexPrices() {
  const key = process.env.TWELVEDATA_API_KEY;
  if (!key) throw new Error('Missing TwelveData API key');
  const symbols = Object.keys(PAIRS).join(',');
  const url = `https://api.twelvedata.com/price?symbol=${encodeURIComponent(symbols)}&apikey=${key}`;
  const res = await fetch(url);
  const data = await res.json();
  // data format: { "EUR/USD": {"price":"1.085"}, "GBP/USD": {...}, ... }
  const prices = {};
  for (const sym of Object.keys(PAIRS)) {
    if (data[sym] && data[sym].price) {
      prices[sym] = parseFloat(data[sym].price);
    } else if (data.price && Object.keys(data).length <= 3) {
      // single symbol response
      prices[sym] = parseFloat(data.price);
    }
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
  if (data.error) throw new Error('Groq: ' + data.error.message);
  return data.choices[0].message.content;
}

async function callGemini(model, system, user) {
  const key = process.env.GEMINI_API_KEY;
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
  if (data.error) throw new Error('Gemini: ' + data.error.message);
  return data.candidates[0].content.parts[0].text;
}

async function callOpenRouter(model, system, user) {
  const key = process.env.OPENROUTER_API_KEY;
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
  return data.choices[0].message.content;
}

// === PARSE AI JSON RESPONSE (robust) ===
export function parseAIDecision(text) {
  if (!text) return null;
  // remove markdown code fences if any
  let cleaned = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  // extract first JSON object
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]);
    const action = String(obj.action || 'HOLD').toUpperCase();
    if (!['BUY','SELL','CLOSE','HOLD'].includes(action)) return null;
    return {
      action,
      reasoning: String(obj.reasoning || 'No reasoning').slice(0, 300),
      confidence: Math.max(0, Math.min(100, parseInt(obj.confidence) || 50))
    };
  } catch {
    return null;
  }
  }
    
