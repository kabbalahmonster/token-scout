# Scoring and confidence 2.0.0

The 100-point score is tuned for practical repeated-swing botting: swings 40,
age/market maturity 15, liquidity 15, activity 15, executable route 10, and
contract posture 5. The API
returns every component's raw inputs, source time, points, and explanation.

Swing scoring rewards frequent balanced 5% events, larger moves, shorter time to
complete each move, repeated round trips, and retained-history coverage. Pair age
has an explicit maturity step at seven days and reaches its cap at thirty days.
This keeps newborn pools below otherwise similar established markets.

Hard fails are narrowly evidence-based: attempted buy with no sell route,
confirmed recovery below 50%, planned capital above one tenth of known pool
liquidity, a non-contract address, or another high-confidence hazard explicitly
classified by the scan. A missing quote is not a hard fail.

Confidence is independent. Known component coverage, retained-history coverage,
and a completed round-trip quote contribute 45/35/20%. Stale/missing history,
route access, age, or risk evidence remains visible under `materialUnknowns`.

`PASS` means score 70+, swing suitability at least 60, pair age at least seven
days, at least 50% seven-day history coverage, at least two completed round
trips, a currently available buy/sell route, and no hard fail. `CAUTION` covers otherwise viable scores of 40+
or candidates missing a readiness gate. `REJECT` means score below 40 or an
evidence-backed hard fail. An informational unknown can lower confidence without
automatically vetoing an otherwise bot-ready market.
