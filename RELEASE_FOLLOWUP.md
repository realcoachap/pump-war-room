# v0.7.2 release acceptance record

`v0.7.1` / Railway deployment `e39df26d-25f1-4802-84ac-42a16313e5af` reached `SUCCESS` at 2026-08-09 06:43 UTC before the v0.7.0 cohort's bounded second attempts began. Production then proved the compatibility fix against fresh provider responses (2 successes in the first 3 post-deploy attempts), but the adversarial gate found remaining truthfulness gaps. Do not announce or treat v0.7.1 as the completed release gate.

The follow-up semantic release (`v0.7.2`) has these acceptance gates:

1. Reject platform/navigation routes that can currently be fingerprinted as handles, including `twitter.com/who_to_follow`, `twitter.com/connect`, `x.com/about`, `x.com/help`, and `t.me/s`. Prefer a conservative positive profile contract or a comprehensive, tested platform-route policy; do not claim a finite denylist rejects every reserved route.
2. Reject decimal percentages whose exact mathematical value exceeds 100 before JavaScript number rounding. Bound input length/precision and test `100.0000000000000000000000000000000000000001`.
3. Add parser-revision provenance without changing the stable fingerprint hash domain merely for representation compatibility.
4. Strengthen deployment smoke evidence so one historical success cannot mask a mostly invalid cohort. Require post-deploy acquisition evidence and explicit invalid-response/coverage thresholds appropriate to the fixed cohort.
5. Re-run the full suite, adversarial review, local version agreement, and a single Railway rollout. Preserve the read-only/no-raw-profile boundary.

The v0.7.1 production smoke otherwise passed with live feed, mounted `/app/data`, zero HTTP 5xx telemetry, HTTP 200 health/snapshot/HTML/JS, and version/mode agreement.
