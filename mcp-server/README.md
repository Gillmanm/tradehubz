# TradeHubz MCP Server

Remote MCP server for TradeHubz and Deriv market analysis.

Endpoint after deployment:
https://<render-service>.onrender.com/mcp

Health:
https://<render-service>.onrender.com/health

Tools:
- list_tradehubz_markets
- analyze_market
- scan_volatility_markets
- analyze_digit_pattern
- build_trade_plan

The server reads live Deriv tick history and returns analytical market data plus a configurable ACCU trade plan.

Risk behavior:
- takeProfit can be used as the accumulator limit-order take-profit when the execution layer requests a proposal.
- stopLoss is an application-level risk guard. Deriv ACCU does not expose it as a native proposal field, so production execution must monitor the position and sell/close when the configured loss threshold is reached.
- The MCP server does not automatically place trades.

Environment:
- PORT: supplied by Render.
- DERIV_APP_ID: Deriv application ID for public market data.
- MCP_API_KEY: secret bearer token protecting /mcp.
- MCP_ALLOWED_ORIGIN: allowed browser origin, or * for server-to-server clients.

Use a dedicated Deriv App ID for this service. No Deriv account token is required for public market-data analysis.
