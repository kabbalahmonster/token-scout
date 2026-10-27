# Swing algorithm 1.0.0

For each configured threshold and horizon, snapshots are sorted by ingest time
and divided wherever the gap exceeds three expected polls. An event cannot
cross that boundary. A directional-change state machine maintains a local high
and low. A down event starts at the running high and completes only after a
confirmed threshold fall; an up event is symmetric. The next opposite event
completes a round trip. Minimum separation and confirmation samples prevent
adjacent noise from being counted repeatedly.

The ledger preserves start/end snapshot IDs, times, decimal price strings,
duration, amplitude, direction, adverse excursion, and round-trip identity.
Aggregate output includes frequency, distributions, drawdown, log-return
volatility, drift, range change, dominant-range time, and coverage quality.
`durationSeconds` measures elapsed time between comparable same-direction event
completions (up-to-up and down-to-down). `eventTraversalDurationSeconds`
separately measures each event's local-extreme-to-threshold traversal.

Raw, 5-minute, and hourly points carry their own expected cadence. Gap
segmentation uses the slower cadence at a tier boundary, so retained hourly
history is not split into one-point segments merely because the live poll
cadence is one minute. Coverage likewise integrates each tier's cadence.

Prices enter `Decimal` before arithmetic. JavaScript `number` is only used for
bounded ratios and displayed statistics. This avoids integer/token-unit loss
while keeping outputs serializable.

Suitability combines event frequency (30%), duration regularity (20%), relative
amplitude (20%), history coverage (20%), dominant range time (10%), and a trend
penalty. It is descriptive—not a forecast.
