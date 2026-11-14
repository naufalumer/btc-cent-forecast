// btc-cent-forecast-01 entry: ensemble Monte Carlo median forecast.
//
// One case file holds 4,320 one-minute BTC/USDC closes (72 h) ending at the
// checkpoint `at`. The task: forecast the close 240 minutes after `at`. The
// score is mean absolute error in cents, and for MAE the optimal point
// forecast is the MEDIAN of the forecast distribution, so this program
// outputs the median terminal price of a Monte Carlo random walk.
//
// The walk's drift is not a single raw model. It is an ensemble of three
// members, combined in log space, with coefficients chosen on the practice
// data by walk-forward loss (96 pseudo-checkpoints cut from the recording,
// plus the 5 labelled practice cases):
//
//   move = 1.00 * REVERT  +  0.50 * TREND  +  0.00 * DRIFT
//
//   REVERT = 0.25 * (mean log price of the last 1,440 min - log last close)
//            Mean reversion toward the 24 h mean. Walk-forward loss
//            40,869 cents vs persistence 43,569; the strongest single
//            member, and its edge held in both halves of the recording.
//   TREND  = 0.50 * (OLS slope of log price over the last 720 min) * 240
//            Damped 12 h trend extrapolation. On its own it is WORSE than
//            persistence (46,263 walk-forward), so it is kept only as a
//            half-strength correction term: the combination beats
//            reversion-alone on walk-forward (40,307 vs 40,869) and on the
//            labelled cases (46,391 vs 49,139).
//   DRIFT  = (mean 1-min log return over the whole window) * 240
//            Coefficient 0. The 72 h mean return is the window's own trend,
//            not a structural signal; including it hurt walk-forward loss.
//
// The walk's per-minute volatility sigma = 1.4826 * MAD of the 1-min log
// returns over the whole window. Sigma sets the spread of the simulated
// distribution; for a symmetric walk the median does not depend on it, so a
// +/-20% sigma change moves the forecast only through finite-sample noise
// (measured: under $1 at 20,001 sims).
//
// Determinism: a fixed-seed mulberry32 generator (no Math.random, no clock,
// no network). Two runs on the same input produce byte-identical output.
// Node 22, standard library only.
//
// Usage (outside the grader): MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out
//   node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** Horizon in minutes: the forecast is the close 240 min after the checkpoint. */
const HORIZON_MIN = 240;
/** Monte Carlo paths. Odd, so the median is one simulated value, not an average. */
const SIMS = 20001;
/** Fixed seed: the same input bytes always give the same output bytes. */
const SEED = 0x62746321; // "btc!" in hex, fixed for this entry
/** Smallest / largest price on the scorer's 5-decimal grid. */
const MIN_PRICE = 0.00001;
const MAX_PRICE = 9_999_999.99999;

/** mulberry32: a small deterministic PRNG (no Math.random anywhere). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One standard normal per call, Box-Muller with a cached spare. */
function makeGaussian(rand: () => number): () => number {
  let spare: number | null = null;
  return () => {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return v;
    }
    let u1 = 0;
    while (u1 === 0) u1 = rand(); // avoid log(0)
    const u2 = rand();
    const r = Math.sqrt(-2 * Math.log(u1));
    const t = 2 * Math.PI * u2;
    spare = r * Math.sin(t);
    return r * Math.cos(t);
  };
}

/** Median of a numeric array (mutates by sorting; callers pass a fresh array). */
function median(xs: number[]): number {
  xs.sort((a, b) => a - b);
  const mid = (xs.length - 1) / 2;
  return xs.length % 2 === 1 ? (xs[mid] as number) : ((xs[mid - 0.5] as number) + (xs[mid + 0.5] as number)) / 2;
}

/** x kept on the grid's 5 decimals and inside the scorer's (0, 10,000,000). */
const price5 = (x: number): number =>
  Math.round(Math.min(MAX_PRICE, Math.max(MIN_PRICE, x)) * 1e5) / 1e5;

interface CaseMarket {
  id: string;
  prices: number[];
}

interface CaseFile {
  markets: CaseMarket[];
}

/**
 * Ensemble log-move (in log-price units over the 240-min horizon) for one
 * market's closes. 0 means "same as persistence".
 */
function ensembleMove(prices: number[]): number {
  const n = prices.length;
  const last = prices[n - 1] as number;
  const logLast = Math.log(last);
  const logs = prices.map((p) => Math.log(p));

  // REVERT: 0.25 * (mean log price, last 1,440 min - log last close).
  const w24 = Math.min(1440, n);
  let sum24 = 0;
  for (let i = n - w24; i < n; i++) sum24 += logs[i] as number;
  const revert = 0.25 * (sum24 / w24 - logLast);

  // TREND: OLS slope of log price over the last 720 min, extrapolated 240
  // min, damped by 0.50.
  const w12 = Math.min(720, n);
  const seg = logs.slice(n - w12);
  const m = w12;
  const mx = (m - 1) / 2;
  let my = 0;
  for (const y of seg) my += y;
  my /= m;
  let num = 0;
  let den = 0;
  for (let i = 0; i < m; i++) {
    const dx = i - mx;
    num += dx * ((seg[i] as number) - my);
    den += dx * dx;
  }
  const slope = den === 0 ? 0 : num / den;
  const trend = 0.5 * slope * HORIZON_MIN;

  // DRIFT coefficient is 0 by design (see header): the 72 h mean return is
  // not included.
  return revert + trend;
}

/** Robust per-minute log volatility: 1.4826 * MAD of the 1-min log returns. */
function madSigma(prices: number[]): number {
  const rets: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    rets.push(Math.log((prices[i] as number) / (prices[i - 1] as number)));
  }
  if (rets.length === 0) return 1e-4;
  const med = median(rets.slice());
  const devs = rets.map((r) => Math.abs(r - med));
  const mad = median(devs);
  // Floor keeps a flat series simulable; cap guards against a corrupt spike.
  return Math.min(0.01, Math.max(1e-5, 1.4826 * mad));
}

/**
 * Median terminal price of SIMS random-walk paths, each HORIZON_MIN steps of
 * N(move / HORIZON_MIN, sigma) in log space, starting at the last close.
 * The median is the MAE-optimal point forecast.
 */
function mcMedianForecast(prices: number[]): number {
  const last = prices[prices.length - 1] as number;
  const move = ensembleMove(prices);
  const sigma = madSigma(prices);
  const driftStep = move / HORIZON_MIN;
  const rand = mulberry32(SEED);
  const gauss = makeGaussian(rand);
  const terminals: number[] = new Array(SIMS);
  for (let s = 0; s < SIMS; s++) {
    let logP = Math.log(last);
    for (let step = 0; step < HORIZON_MIN; step++) {
      logP += driftStep + sigma * gauss();
    }
    terminals[s] = Math.exp(logP);
  }
  return price5(median(terminals));
}

/** One case's forecast; falls back to persistence if anything is malformed. */
function forecastCase(c: CaseFile): number {
  const m = c.markets[0] as CaseMarket;
  if (!Array.isArray(m.prices) || m.prices.length === 0) {
    throw new Error(`market ${m.id} has no prices`);
  }
  const last = m.prices[m.prices.length - 1] as number;
  if (typeof last !== 'number' || !Number.isFinite(last) || last <= 0) {
    throw new Error(`market ${m.id}'s last price is not a finite positive number`);
  }
  return mcMedianForecast(m.prices);
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as CaseFile;
  let price: number;
  try {
    if (!Array.isArray(c.markets) || c.markets.length !== 1) {
      throw new Error(`${file} does not hold exactly one market`);
    }
    price = forecastCase(c);
  } catch (e) {
    // A malformed case still gets a valid answer (persistence) instead of
    // failing the whole run; the error goes to stderr for the record.
    const fallback = (() => {
      try {
        const m = (c.markets as CaseMarket[])[0];
        const p = m?.prices?.[m.prices.length - 1];
        return typeof p === 'number' && Number.isFinite(p) && p > 0 ? price5(p) : MIN_PRICE;
      } catch {
        return MIN_PRICE;
      }
    })();
    console.error(`warning: ${file}: ${(e as Error).message}; falling back to persistence ${fallback}`);
    price = fallback;
  }
  writeFileSync(
    join(OUTPUT_DIR, `${id}.out`),
    `${JSON.stringify({ forecasts: [{ case: id, price }] })}\n`,
  );
}
