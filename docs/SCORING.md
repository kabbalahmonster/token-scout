# Scoring and confidence 1.0.0

The 100-point score follows the README weights: liquidity 25, executable route
20, swings 20, activity 15, stability 10, and contract posture 10. The API
returns every component's raw inputs, source time, points, and explanation.

Hard fails are narrowly evidence-based: attempted buy with no sell route,
confirmed recovery below 50%, planned capital above one tenth of known pool
liquidity, a non-contract address, or another high-confidence hazard explicitly
classified by the scan. A missing quote is not a hard fail.

Confidence is independent. Known component coverage, retained-history coverage,
and a completed round-trip quote contribute 45/35/20%. Stale/missing history,
route access, age, or risk evidence appears under `materialUnknowns` and prevents
a PASS even if known inputs score highly.
