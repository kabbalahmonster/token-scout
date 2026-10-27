# Swing algorithm 2.0.0

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
Attributed GeckoTerminal hourly candles use the same 3,600-second cadence and
are stored before analysis; provider 24-hour percentage changes are never used
as synthetic price history.

Prices enter `Decimal` before arithmetic. JavaScript `number` is only used for
bounded ratios and displayed statistics. This avoids integer/token-unit loss
while keeping outputs serializable.

Suitability is tuned for repeated real-world bot opportunities. It combines
balanced two-way event frequency (25%), amplitude above the configured threshold
(25%), local-extreme-to-threshold speed (20%), completed round-trip repetition
(15%), history coverage (10%), and up/down balance (5%). Frequency saturates at
three balanced events per day, amplitude and repetition are capped, and traversal
speed decays logarithmically after one hour. This prevents one noisy outlier from
dominating the rating.

Net drift above 25% receives a bounded penalty of at most 15 points. Strong drift
therefore remains visible without erasing dozens of genuine completed swings.
Suitability is descriptive—not a forecast.
