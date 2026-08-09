---
type: pump-narrative
narrative: "AI agents"
---

# AI agents

## Coins

```dataview
TABLE symbol, momentum_score, risk_evidence, market_cap_usd
FROM "Coins"
WHERE narrative = "AI agents"
SORT momentum_score DESC
```
