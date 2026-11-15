'use strict';

// Deterministic next-price forecaster for short-horizon crypto-style series.
// Pure standard library: no network, no clock, no randomness.

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------- constants

const FALLBACK_PRICE = 60000; // sane stand-in when history carries no usable price
const MIN_PRICE = 0.00001; // output contract lower bound
const MAX_PRICE = 9999999.99999; // output contract upper bound

const HORIZONS = [120, 180, 240]; // look-back horizons in minutes
const WINSOR_SIGMAS = 4; // clip returns this many std-dev from their mean
const Z_DAMPEN = 1.5; // |z| above this means "unusual move"
const DAMPEN_FACTOR = 0.5; // drift multiplier when the move is unusual
const SHRINK = 0.6; // global shrink of drift toward zero / persistence
const MAX_DRIFT = 0.05; // hard clamp: final price stays within 5% of last
const REGIME_BARS = 60; // "about the last hour" of move
const VOL_BARS = 720; // "about the last 12 hours" of volatility
const MIN_HISTORY = 130; // below this many points, only persistence is honest

// ------------------------------------------------------------- small helpers

/** Round to 5 decimals and clamp into the contract's allowed price range. */
function round5(value) {
  if (!isFinite(value)) return FALLBACK_PRICE;
  const rounded = Math.round(value * 1e5) / 1e5;
  if (!isFinite(rounded)) return FALLBACK_PRICE;
  return Math.min(MAX_PRICE, Math.max(MIN_PRICE, rounded));
}

/** Median of a numeric array (NaN when empty). Does not mutate the input. */
function median(values) {
  if (!values || values.length === 0) return NaN;
  const sorted = values.slice().sort(function (a, b) {
    return a - b;
  });
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

/** True when a point can be used as a price. */
function isPrice(value) {
  return typeof value === 'number' && isFinite(value) && value > 0;
}

/** Keep only usable prices so one junk entry cannot poison the statistics. */
function cleanPrices(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    if (isPrice(raw[i])) out.push(raw[i]);
  }
  return out;
}

/** Clip each return to +/-sigmas standard deviations around the mean. */
function winsorize(returns, sigmas) {
  const n = returns.length;
  if (n === 0) return [];
  let sum = 0;
  for (let i = 0; i < n; i++) sum += returns[i];
  const mean = sum / n;
  let squares = 0;
  for (let i = 0; i < n; i++) {
    const d = returns[i] - mean;
    squares += d * d;
  }
  const sd = Math.sqrt(squares / n);
  if (!(sd > 0) || !isFinite(sd)) return returns.slice();
  const low = mean - sigmas * sd;
  const high = mean + sigmas * sd;
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.min(high, Math.max(low, returns[i]));
  return out;
}

/** All h-step simple returns (price later / price now - 1) over the history. */
function horizonReturns(prices, horizon) {
  const out = [];
  const n = prices.length;
  for (let i = 0; i + horizon < n; i++) {
    const base = prices[i];
    if (!isPrice(base)) continue;
    const r = prices[i + horizon] / base - 1;
    if (isFinite(r)) out.push(r);
  }
  return out;
}

/** Sample-count weighted blend of the winsorized median drift per horizon. */
function blendedDrift(prices) {
  let weighted = 0;
  let samples = 0;
  for (let k = 0; k < HORIZONS.length; k++) {
    const horizon = HORIZONS[k];
    if (prices.length <= horizon + 1) continue;
    const returns = horizonReturns(prices, horizon);
    if (returns.length === 0) continue;
    const med = median(winsorize(returns, WINSOR_SIGMAS));
    if (!isFinite(med)) continue;
    weighted += med * returns.length;
    samples += returns.length;
  }
  if (samples === 0) return 0;
  return weighted / samples;
}

/** Standard deviation of 1-step returns over the most recent window. */
function recentVolatility(prices, window) {
  const n = prices.length;
  const start = Math.max(1, n - window);
  const rets = [];
  for (let i = start; i < n; i++) {
    if (!isPrice(prices[i - 1])) continue;
    const r = prices[i] / prices[i - 1] - 1;
    if (isFinite(r)) rets.push(r);
  }
  if (rets.length < 2) return 0;
  let sum = 0;
  for (let i = 0; i < rets.length; i++) sum += rets[i];
  const mean = sum / rets.length;
  let squares = 0;
  for (let i = 0; i < rets.length; i++) {
    const d = rets[i] - mean;
    squares += d * d;
  }
  const sd = Math.sqrt(squares / rets.length);
  return isFinite(sd) && sd > 0 ? sd : 0;
}

/** Z-score of the last hour's move against the last 12 hours' volatility. */
function regimeZScore(prices) {
  const n = prices.length;
  const bars = Math.min(REGIME_BARS, n - 1);
  if (bars < 10) return 0;
  const anchor = prices[n - 1 - bars];
  if (!isPrice(anchor)) return 0;
  const move = prices[n - 1] / anchor - 1;
  if (!isFinite(move)) return 0;
  const vol = recentVolatility(prices, VOL_BARS);
  if (!(vol > 0)) return 0;
  const z = move / (vol * Math.sqrt(bars));
  return isFinite(z) ? z : 0;
}

/** Newest usable price in the series, else the sane constant fallback. */
function lastUsablePrice(prices) {
  for (let i = prices.length - 1; i >= 0; i--) {
    if (isPrice(prices[i])) return prices[i];
  }
  return FALLBACK_PRICE;
}

/** Full per-market forecast: persistence + damped, shrunk empirical drift. */
function forecastMarket(market) {
  const raw = market && typeof market === 'object' ? market.prices : undefined;

  // Missing or empty history: there is nothing to extrapolate from at all.
  if (!Array.isArray(raw) || raw.length === 0) return round5(FALLBACK_PRICE);

  const prices = cleanPrices(raw);
  const last = lastUsablePrice(prices);

  // Too little history (or a last value that is not a positive finite number):
  // persistence over the safe constant is the only defensible answer.
  if (prices.length < MIN_HISTORY) return round5(last);

  // Empirical drift from multi-horizon medians.
  let drift = blendedDrift(prices);
  if (!isFinite(drift)) drift = 0;

  // Regime damping: an outsized recent move usually mean-reverts.
  const z = regimeZScore(prices);
  if (Math.abs(z) > Z_DAMPEN) drift *= DAMPEN_FACTOR;

  // Shrink toward persistence, then clamp the implied move to +/-5%.
  drift *= SHRINK;
  if (drift > MAX_DRIFT) drift = MAX_DRIFT;
  if (drift < -MAX_DRIFT) drift = -MAX_DRIFT;

  return round5(last * (1 + drift));
}

// ------------------------------------------------------------------- main

function main() {
  const inputDir = process.env.MAKEFUN_INPUT_DIR || '/input';
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR || '/output';

  try {
    fs.mkdirSync(outputDir, { recursive: true });
  } catch (err) {
    // nothing sensible to do; writes below will simply be skipped if impossible
  }

  let names = [];
  try {
    names = fs.readdirSync(inputDir).sort();
  } catch (err) {
    names = [];
  }

  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    if (!name.toLowerCase().endsWith('.in')) continue;
    const stem = name.slice(0, -3);

    // Any failure (bad JSON, missing array, junk values) degrades to a fallback.
    let price = FALLBACK_PRICE;
    try {
      const raw = fs.readFileSync(path.join(inputDir, name), 'utf8');
      const parsed = JSON.parse(raw);
      const markets = parsed && Array.isArray(parsed.markets) ? parsed.markets : [];
      const market = markets.length > 0 && markets[0] && typeof markets[0] === 'object' ? markets[0] : {};
      price = forecastMarket(market);
    } catch (err) {
      price = FALLBACK_PRICE;
    }

    const record = { forecasts: [{ case: stem, price: round5(price) }] };
    try {
      fs.writeFileSync(path.join(outputDir, stem + '.out'), JSON.stringify(record) + '\n', 'utf8');
    } catch (err) {
      // ignore individual write failures and keep processing other files
    }
  }
}

main();
