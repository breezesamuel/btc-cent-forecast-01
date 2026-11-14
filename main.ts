// btc-cent-forecast-01 entry — empirical-median with multi-window & regime damping.
// Model: blend-of-empirical-medians-shrunk-toward-persistence.
// Deterministic, no randomness, no clock, no network. Node 22 standard lib only.
'use strict';
const { mkdirSync, readdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const MIN_PRICE = 0.00001;
const MAX_PRICE = 9_999_999.99999;
const PRICE_GRID = 1e5; // 5 decimals
const WIN = [120, 180, 240]; // look-back windows in minutes to aggregate
const WIN_WT = [1, 2, 3];    // weight each window by its sample count proportionally
const DAMP_TAIL = 0.5;      // when tail-clipping, shrink extreme returns toward zero by half
const REGIME_CLIP = 1.5;    // z-score clip for unusual recent moves → dampen forecast

/** x kept on the grid's 5 decimals and inside (0, 10,000,000). */
const price5 = (x) => Math.round(Math.min(MAX_PRICE, Math.max(MIN_PRICE, x)) * PRICE_GRID) / PRICE_GRID;

/** Median of a sorted numeric array (even-count → mean of two middles). */
function median(arr) {
  const n = arr.length;
  if (!n) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = (n - 1) / 2;
  if (Number.isInteger(mid)) return s[mid];
  return (s[Math.floor(mid)] + s[Math.ceil(mid)]) / 2;
}

/** Winsorize tails: clip values to ±clip_std around the mean, then re-normalize. */
function winsor(arr, clip_std) {
  if (arr.length < 4) return arr.slice();
  const m = arr.reduce((a, b) => a + b, 0) / arr.length;
  const sd = Math.sqrt(arr.reduce((a, v) => a + (v - m) ** 2, 0) / arr.length) || 1e-12;
  const lo = m - clip_std * sd, hi = m + clip_std * sd;
  return arr.map(v => Math.max(lo, Math.min(hi, v)));
}

/** Forecast for one market using multi-window blended empirical median. */
function forecast(market) {
  const prices = market.prices;
  if (!Array.isArray(prices) || prices.length < 121) {
    // too short for any useful window → persistence
    return price5(prices && prices[prices.length - 1]);
  }
  const n = prices.length, last = prices[n - 1];
  if (typeof last !== 'number' || !Number.isFinite(last) || last <= 0) return price5(last || 1);

  // regime detection: how extreme was the last minute relative to recent volatility?
  let zLast = 0;
  if (n > 720) {
    const recent = prices.slice(-60);
    const trail = prices.slice(-720);
    const rets = [];
    for (let i = 1; i < recent.length; i++) rets.push((recent[i] - recent[i - 1]) / recent[i]);
    if (rets.length >= 3) {
      const mR = rets.reduce((a, b) => a + b, 0) / rets.length;
      const sdR = Math.sqrt(rets.reduce((a, r) => a + (r - mR) ** 2, 0) / rets.length) || 1e-12;
      const lastRet = (recent[recent.length - 1] - recent[0]) / recent[0];
      zLast = (lastRet - mR) / sdR;
    }
  }
  const regimeDamp = Math.abs(zLast) > REGIME_CLIP ? DAMP_TAIL : 1;

  // collect per-window empirical medians of h-step forward returns (h = WIN window length)
  const wts = [], nums = []; // pairs of (weight, median-return)
  for (let wi = 0; wi < WIN.length; wi++) {
    const h = WIN[wi];
    if (n <= h) continue;
    const deltas = [];
    for (let j = 0; j <= n - h - 1; j++) {
      const d = prices[j + h] / prices[j] - 1;
      deltas.push(d);
    }
    if (deltas.length < 20) continue; // too few samples for this window
    const clipped = winsor(deltas, 4);
    const med = median(clipped) * regimeDamp;
    wts.push(WIN_WT[wi] * deltas.length);
    nums.push(med);
  }
  // blended empirical median
  const sumW = wts.reduce((a, b) => a + b, 0);
  if (sumW === 0) return price5(last);
  const emp = nums.reduce((a, v, i) => a + v * wts[i], 0) / sumW;
  // shrink toward zero (persistence) so the blend never strays far
  const guess = last * (1 + emp * 0.6);
  // hard clamp: ±5% band around checkpoint
  const clamped = Math.max(last * 0.95, Math.min(last * 1.05, guess));
  return price5(clamped);
}

const fs = require('fs');
mkdirSync(OUTPUT_DIR, { recursive: true });
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  try {
    const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8'));
    if (!Array.isArray(c.markets) || c.markets.length !== 1) {
      throw new Error(`${file}: expected exactly 1 market`);
    }
    const p = forecast(c.markets[0]);
    writeFileSync(join(OUTPUT_DIR, `${id}.out`),
      JSON.stringify({ forecasts: [{ case: id, price: p }] }) + '\n');
  } catch (e) {
    // malformed case → persistence fallback, never throw
    const x = 60_000;
    writeFileSync(join(OUTPUT_DIR, `${id}.out`),
      JSON.stringify({ forecasts: [{ case: id, price: price5(x) }] }) + '\n');
    console.error(`[WARN] ${file}: ${e.message}`);
  }
}
