# Placeholder prompt

The real Night-Before NSE Intraday Stock Selection prompt is private and is not
in this repository. Put yours in `prompts/night-before.local.md` (gitignored);
the app uses that file when it exists and this one otherwise.

Your prompt can use two placeholders, filled from Risk & sizing:

- Capital: ₹{{CAPITAL}}
- Risk per trade: {{RISK_PERCENT}}%

Analyse the market data below and produce a night-before intraday watchlist.
