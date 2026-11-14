# Bitcoin 4h forecast

Entry for make.fun competition `btc-cent-forecast-01`: forecast Bitcoin's
price 4 hours ahead, 12 times over 48 hours. The program reads one case file
(`<id>.in`: 4,320 one-minute BTC/USDC closes over 72 h up to the checkpoint)
and writes `<id>.out` with a single price: the expected close 240 minutes
after the checkpoint.

## Method

Score is mean absolute error in cents, so the optimal point forecast is the
**median** of the forecast distribution. The program outputs the median
terminal price of a Monte Carlo random walk (20,001 paths, fixed seed,
deterministic — two runs are byte-identical).

The walk's drift is an **ensemble**, not one raw model, combined in log
space with coefficients chosen on the practice data by walk-forward loss:

- **Mean reversion** (weight 1.00): 0.25 × (mean log price of the last
  24 h − log last close). The strongest single member on walk-forward.
- **Damped trend** (weight 0.50): 0.50 × (OLS slope of log price over the
  last 12 h) × 240 min. Worse than persistence on its own, kept only as a
  half-strength correction — the combination beats reversion alone.
- **Drift** (weight 0.00): excluded. The 72 h mean return is the window's
  own trend, not a structural signal; including it hurt walk-forward loss.
- **Persistence** is the anchor: with all moves zero the forecast is the
  last close.

Volatility sigma = 1.4826 × MAD of the 1-minute log returns. Sigma sets the
spread of the simulated distribution; for a symmetric walk the median does
not depend on it.

## Practice scores (local, honest)

Practice = 6 cases p00–p05, 4 h apart, cut from the recording
2026-11-07T06:00Z to 2026-11-11T06:00Z. Each case's target is the next
case's last price, so p00–p04 have derivable answers; p05's target
(2026-11-11T06:00Z) is in no case file, so local scoring covers p00–p04
only (5 cases). The published house baseline loss over all 6 cases is
44,521.576667 cents.

Local results (mean absolute error, cents) — measured with `score.mjs`
(run `node score.mjs` from the competition work dir; answers p00–p04 are
each case's target = the next case file's last price):

| variant | p00 | p01 | p02 | p03 | p04 | mean |
| --- | --- | --- | --- | --- | --- | --- |
| persistence (house baseline) | 31,711 | 76,697 | 47,033 | 56,685 | 23,147 | 47,055 |
| this entry (MC median) | 28,808 | 71,383 | 59,513 | 53,844 | 18,470 | 46,404 |

This entry beats persistence on 4 of 5 scored cases (all but p02, where it
is 12,479 cents worse) and on the mean (−1.4%). On the wider walk-forward
evaluation (96 pseudo-checkpoints cut from the recording, ~20 distinct
times) it scores 40,307 vs persistence 43,569 (−7.5%). Two full runs are
byte-identical; runtime ~0.47 s/case (limit 8 s).

Honest limits, read before judging the entry:

- **No variant beats persistence on all 5 scored cases.** The 5/5 gate
  cannot be met by any robust estimator: p01/p02 (down moves after a
  downtrend) and p03 (an up move after the same downtrend) demand
  opposite signs from the same features. Coefficients fitted to satisfy
  both signs (e.g. 4h-momentum ×4 with 24h-reversion) score 3–4× WORSE
  than persistence on walk-forward — pure overfitting, rejected with the
  numbers in the build notes. This entry is the best-supported compromise:
  best walk-forward mean among blends that also beat persistence on the
  labelled-case mean, with the smallest worst-case blowup (+12,479 on p02).
- **A practice score is no guide to the final**: the final is 12 fresh
  cases over 15–17 Nov 2026, a different window and regime. The numbers
  above are reported so the method can be checked, not as an expectation.

Rejected variants (labelled-case mean, cents; walk-forward mean in brackets):

- pure persistence: 47,055 [43,569] — the house baseline itself.
- damped trend alone (12 h OLS × 0.5): 44,299 [46,263] — wins the 5 tail
  cases only because 4 of 5 moves were down; walk-forward says trend
  continuation loses on average. Rejected.
- mean reversion alone (24 h mean, k=0.25): 49,139 [40,869] — best
  single member on walk-forward but worse than persistence on the
  labelled mean. Rejected alone; kept as the ensemble's main member.
- regression reversion (next return = −0.2 × prior 24 h return):
  47,265 [38,377] — best walk-forward of all, but worse than persistence
  on the labelled mean with a +23,130 worst case. Rejected: too strong,
  fat tail risk.
- 72 h drift (any weight): hurts walk-forward at every weight tried;
  excluded (coefficient 0), per the method brief's default.
- model averaging of the top-5 walk-forward blends: 47,067 [40,673] —
  no better than persistence on the labelled mean. Rejected.

Monte Carlo stability (20,001 paths, measured with `mc-check.mjs`):
median spread across 5 seeds $0.58–$2.84 per case; sigma ±20% moves the
median by at most $0.23 (the median of a symmetric walk does not depend
on sigma — only finite-sample noise). Entry-seed median vs analytic
blend: ≤ $0.58 per case.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Node 22, standard library only, no network. Reads every `*.in` in the
input directory (name order), writes `<id>.out` per case:
`{"forecasts":[{"case":"<id>","price":<number>}]}`.

## Files

- `main.ts` — the entry (the only program file)
- `LICENSE` — MIT
- `README.md` — this file
