# 🤖 AI Forex Team — Real AI Edition

Multi-pair forex trading simulator powered by **real AI** (Groq, Gemini, OpenRouter), **real forex data** (TwelveData), and **persistent database** (Supabase).

5 AI traders with distinct personalities trade $10,000 virtual money across 6 currency pairs. All decisions made by actual LLMs, all history stored permanently.

## 🌐 Live Demo

https://ai-forex-team.vercel.app

## 🏗️ Stack

- **Frontend**: Vanilla HTML/CSS/JS (mobile-first)
- **Backend**: Vercel Serverless Functions (Node.js)
- **Database**: Supabase (PostgreSQL)
- **AI Providers**: Groq, Google Gemini, OpenRouter (DeepSeek, Llama 4)
- **Forex Data**: TwelveData API
- **Scheduler**: cron-job.org (external)

## 🎭 The Team

| Trader | Strategy | AI Model | Pairs |
|---|---|---|---|
| 🦅 Aggressive Alex | Scalping, high risk | Groq Llama 3.3 70B | EUR/USD, GBP/USD, USD/JPY |
| 🐢 Cautious Carla | Swing, low risk | Gemini 2.0 Flash | EUR/USD, AUD/USD |
| 📰 News Nina | Fundamental/news | OpenRouter DeepSeek V3 | EUR/USD, EUR/JPY, GBP/USD |
| 🤖 Quant Quincy | Technical (RSI/MA) | OpenRouter Llama 3.3 | All 6 pairs |
| 🎰 YOLO Yuki | Contrarian, very high risk | Groq Llama 3.1 8B | USD/JPY, EUR/JPY, GBP/USD |

## 🔐 Environment Variables (Vercel)

```
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_ANON_KEY=eyJhbG...
GROQ_API_KEY=gsk_...
GEMINI_API_KEY=AIzaSy...
OPENROUTER_API_KEY=sk-or-v1-...
TWELVEDATA_API_KEY=...
```

## 📡 API Endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/get-data` | GET | Fetch all data (traders, trades, news, equity) |
| `/api/forex` | GET | Get current forex prices (cached 60s) |
| `/api/run-cycle` | POST | Trigger AI trading cycle (called by cron) |
| `/api/chat` | POST | Chat with a specific AI trader |

## ⏰ Cron Setup

Setup cron-job.org to POST to `/api/run-cycle` every 15-30 minutes.

## ⚠️ Disclaimer

This is an educational simulation. Not financial advice. Virtual money only.
