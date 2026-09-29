import { createServer } from 'node:http';
import WebSocket, { type RawData } from 'ws';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const PORT = Number(process.env.PORT ?? 10000);
const DERIV_APP_ID = process.env.DERIV_APP_ID ?? '1089';
const MCP_API_KEY = process.env.MCP_API_KEY ?? '';
const ALLOWED_ORIGIN = process.env.MCP_ALLOWED_ORIGIN ?? '*';

const VOLATILITY_SYMBOLS = [
  'R_10', '1HZ10V', 'R_25', '1HZ25V', 'R_50',
  '1HZ50V', 'R_75', '1HZ75V', 'R_100', '1HZ100V'
] as const;

const DISPLAY_NAMES: Record<string, string> = {
  R_10: 'Volatility 10 Index', '1HZ10V': 'Volatility 10 (1s) Index',
  R_25: 'Volatility 25 Index', '1HZ25V': 'Volatility 25 (1s) Index',
  R_50: 'Volatility 50 Index', '1HZ50V': 'Volatility 50 (1s) Index',
  R_75: 'Volatility 75 Index', '1HZ75V': 'Volatility 75 (1s) Index',
  R_100: 'Volatility 100 Index', '1HZ100V': 'Volatility 100 (1s) Index'
};

type TickPoint = { epoch: number; quote: number };

class DerivMarketClient {
  private ws: WebSocket | null = null;
  private connecting: Promise<WebSocket> | null = null;

  private async connect(): Promise<WebSocket> {
    if (this.ws?.readyState === WebSocket.OPEN) return this.ws;
    if (this.connecting) return this.connecting;

    const connection = new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(
        'wss://ws.derivws.com/websockets/v3?app_id=' + encodeURIComponent(DERIV_APP_ID)
      );
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('Deriv WebSocket connection timeout'));
      }, 10000);

      ws.once('open', () => {
        clearTimeout(timeout);
        this.ws = ws;
        resolve(ws);
      });
      ws.once('error', err => {
        clearTimeout(timeout);
        reject(err);
      });
      ws.once('close', () => {
        if (this.ws === ws) this.ws = null;
      });
    });
    this.connecting = connection;
    void connection.finally(() => {
      if (this.connecting === connection) this.connecting = null;
    });

    return connection;
  }

  async request<T>(payload: Record<string, unknown>): Promise<T> {
    const ws = await this.connect();
    const reqId = Math.random().toString(36).slice(2) + Date.now().toString(36);

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error('Deriv API request timeout')); }, 15000);

      const onMessage = (raw: RawData) => {
        try {
          const data = JSON.parse(raw.toString()) as Record<string, unknown>;
          if (data.req_id !== reqId) return;
          cleanup();
          if (data.error) {
            const error = data.error as { code?: string; message?: string };
            reject(new Error('Deriv API: ' + (error.code ?? 'ERROR') + ' - ' + (error.message ?? 'Unknown error')));
            return;
          }
          resolve(data as T);
        } catch (err) {
          cleanup();
          reject(err);
        }
      };

      const onClose = () => { cleanup(); reject(new Error('Deriv WebSocket closed')); };
      const cleanup = () => {
        clearTimeout(timer);
        ws.off('message', onMessage);
        ws.off('close', onClose);
      };

      ws.on('message', onMessage);
      ws.once('close', onClose);
      ws.send(JSON.stringify({ ...payload, req_id: reqId }));
    });
  }

  async getTicks(symbol: string, count: number): Promise<TickPoint[]> {
    const response = await this.request<{ history?: { times?: number[]; prices?: number[] } }>({
      ticks_history: symbol,
      end: 'latest',
      count: Math.min(Math.max(count, 20), 2000),
      style: 'ticks'
    });
    const times = response.history?.times ?? [];
    const prices = response.history?.prices ?? [];
    return prices.map((quote, i) => ({ epoch: times[i] ?? 0, quote: Number(quote) }));
  }

  async getActiveSymbols(): Promise<unknown> {
    return this.request({ active_symbols: 'brief', product_type: 'basic' });
  }
}

const marketClient = new DerivMarketClient();

function mean(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function std(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(mean(values.map(v => (v - m) ** 2)));
}

function returns(prices: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1] !== 0) out.push((prices[i] - prices[i - 1]) / prices[i - 1]);
  }
  return out;
}

function rsi(prices: number[], period = 14): number {
  if (prices.length <= period) return 50;
  const slice = prices.slice(-(period + 1));
  let gains = 0;
  let losses = 0;
  for (let i = 1; i < slice.length; i++) {
    const d = slice[i] - slice[i - 1];
    if (d >= 0) gains += d;
    else losses -= d;
  }
  if (losses === 0) return 100;
  return 100 - 100 / (1 + gains / losses);
}

function analyzePrices(symbol: string, ticks: TickPoint[]) {
  const prices = ticks.map(t => t.quote);
  const current = prices.at(-1) ?? 0;
  const lookback = Math.min(50, Math.floor(prices.length / 2));
  const recent = prices.slice(-lookback);
  const previous = prices.slice(-lookback * 2, -lookback);
  const recentMean = mean(recent);
  const previousMean = mean(previous.length ? previous : recent);
  const slope = recent.length > 1 ? (recent.at(-1)! - recent[0]) / recent.length : 0;
  const changePct = previousMean ? ((recentMean - previousMean) / previousMean) * 100 : 0;
  const retVol = std(returns(recent)) * 100;
  const rsiValue = rsi(prices);
  const high = Math.max(...recent);
  const low = Math.min(...recent);
  const range = high - low;

  let direction: 'UP' | 'DOWN' | 'NEUTRAL' = 'NEUTRAL';
  if (slope > 0 && rsiValue < 72) direction = 'UP';
  if (slope < 0 && rsiValue > 28) direction = 'DOWN';

  const momentumScore = Math.min(100, Math.abs(changePct) * 20 + Math.abs(rsiValue - 50));
  const confidence = Math.round(Math.min(95, 45 + momentumScore * 0.55 + (retVol > 0 ? 5 : 0)));

  const buffer = Math.max(range * 0.15, Math.abs(current) * 0.0005);
  const targetDistance = Math.max(range * 0.35, buffer);
  const stopDistance = Math.max(range * 0.20, buffer * 0.7);

  return {
    symbol,
    market: DISPLAY_NAMES[symbol] ?? symbol,
    currentPrice: current,
    direction,
    confidence,
    rsi: Number(rsiValue.toFixed(2)),
    recentChangePct: Number(changePct.toFixed(4)),
    tickVolatilityPct: Number(retVol.toFixed(4)),
    recentHigh: high,
    recentLow: low,
    entry: current,
    takeProfit: direction === 'UP' ? current + targetDistance : direction === 'DOWN' ? current - targetDistance : current,
    stopLoss: direction === 'UP' ? current - stopDistance : direction === 'DOWN' ? current + stopDistance : current,
    dataPoints: prices.length
  };
}

function digitsAnalysis(ticks: TickPoint[]) {
  const counts = Array.from({ length: 10 }, () => 0);
  for (const tick of ticks) {
    const digit = Number(String(tick.quote).replace(/[^0-9]/g, '').at(-1));
    if (Number.isInteger(digit) && digit >= 0 && digit <= 9) counts[digit]++;
  }
  const total = counts.reduce((a, b) => a + b, 0) || 1;
  return counts.map((count, digit) => ({
    digit, count, percentage: Number(((count / total) * 100).toFixed(2))
  })).sort((a, b) => b.count - a.count);
}

function riskPlan(input: {
  direction: 'UP' | 'DOWN' | 'NEUTRAL';
  stake: number;
  takeProfit?: number;
  stopLoss?: number;
  growthRate: number;
}) {
  const tp = input.takeProfit && input.takeProfit > 0 ? input.takeProfit : input.stake * 0.5;
  const sl = input.stopLoss && input.stopLoss > 0 ? input.stopLoss : input.stake * 0.25;
  return {
    stake: input.stake,
    growthRate: input.growthRate,
    takeProfitAmount: tp,
    stopLossAmount: sl,
    maxLossPercentOfStake: Number(((sl / input.stake) * 100).toFixed(2)),
    riskRewardAmountRatio: Number((tp / sl).toFixed(2)),
    direction: input.direction,
    note: 'For ACCU, take-profit can be sent in limit_order. Stop-loss is an application-level risk guard and must be enforced by monitoring/selling; it is not a native ACCU proposal field.'
  };
}

function buildServer(): McpServer {
  const server = new McpServer({ name: 'tradehubz-market-analysis', version: '1.0.0' });

  server.registerTool('list_tradehubz_markets', {
    description: 'List Deriv markets available to TradeHubz, including Volatility Indices and their symbols.',
    inputSchema: z.object({})
  }, async () => {
    const data = await marketClient.getActiveSymbols() as { active_symbols?: Array<Record<string, unknown>> };
    const markets = (data.active_symbols ?? []).filter(s => typeof s.symbol === 'string').map(s => ({
      symbol: s.symbol,
      displayName: DISPLAY_NAMES[String(s.symbol)] ?? s.display_name ?? s.symbol,
      market: s.market,
      submarket: s.submarket,
      pipSize: s.pip,
      exchangeIsOpen: s.exchange_is_open
    }));
    return { content: [{ type: 'text', text: JSON.stringify({ markets }, null, 2) }] };
  });

  server.registerTool('analyze_market', {
    description: 'Analyze a selected Deriv market from live tick history. Returns direction, entry, take-profit, stop-loss reference, RSI, volatility, support/resistance and confidence. Analytical information only.',
    inputSchema: z.object({
      symbol: z.string(),
      tickCount: z.number().int().min(50).max(2000).default(200),
      growthRate: z.number().min(0.01).max(0.20).default(0.01),
      stake: z.number().positive().default(10),
      takeProfit: z.number().positive().optional(),
      stopLoss: z.number().positive().optional()
    })
  }, async ({ symbol, tickCount, growthRate, stake, takeProfit, stopLoss }) => {
    const ticks = await marketClient.getTicks(symbol, tickCount);
    if (ticks.length < 20) throw new Error('Not enough market data');
    const analysis = analyzePrices(symbol, ticks);
    const plan = riskPlan({ direction: analysis.direction, stake, growthRate, takeProfit, stopLoss });
    return { content: [{ type: 'text', text: JSON.stringify({
      analysis, riskPlan: plan,
      disclaimer: 'Confidence is an internal analytical score, not a probability of profit.'
    }, null, 2) }] };
  });

  server.registerTool('scan_volatility_markets', {
    description: 'Scan Volatility 10/25/50/75/100 and 1-second variants using live tick data. Returns analyses above the requested confidence threshold for further review.',
    inputSchema: z.object({
      tickCount: z.number().int().min(50).max(500).default(150),
      minConfidence: z.number().min(0).max(100).default(60),
      growthRate: z.number().min(0.01).max(0.20).default(0.01),
      stake: z.number().positive().default(10),
      takeProfit: z.number().positive().optional(),
      stopLoss: z.number().positive().optional()
    })
  }, async ({ tickCount, minConfidence, growthRate, stake, takeProfit, stopLoss }) => {
    const results = await Promise.allSettled(VOLATILITY_SYMBOLS.map(async symbol => {
      const ticks = await marketClient.getTicks(symbol, tickCount);
      const analysis = analyzePrices(symbol, ticks);
      return { ...analysis, riskPlan: riskPlan({ direction: analysis.direction, stake, growthRate, takeProfit, stopLoss }) };
    }));
    const markets = results
      .filter(r => r.status === 'fulfilled')
      .map(r => r.value)
      .filter(a => a.confidence >= minConfidence)
      .sort((a, b) => b.confidence - a.confidence);
    return { content: [{ type: 'text', text: JSON.stringify({
      scanned: VOLATILITY_SYMBOLS.length, returned: markets.length, markets,
      disclaimer: 'The ordering is an analytical sort, not a prediction or guarantee.'
    }, null, 2) }] };
  });

  server.registerTool('analyze_digit_pattern', {
    description: 'Analyze last digits of Deriv tick quotes. Returns digit frequency and transition counts for digit-contract research.',
    inputSchema: z.object({
      symbol: z.string(),
      tickCount: z.number().int().min(50).max(2000).default(100)
    })
  }, async ({ symbol, tickCount }) => {
    const ticks = await marketClient.getTicks(symbol, tickCount);
    const frequency = digitsAnalysis(ticks);
    const transitions: Record<string, Record<string, number>> = {};
    for (let i = 1; i < ticks.length; i++) {
      const prev = String(ticks[i - 1].quote).replace(/[^0-9]/g, '').at(-1);
      const next = String(ticks[i].quote).replace(/[^0-9]/g, '').at(-1);
      if (!prev || !next) continue;
      transitions[prev] ??= {};
      transitions[prev][next] = (transitions[prev][next] ?? 0) + 1;
    }
    return { content: [{ type: 'text', text: JSON.stringify({
      symbol, sampleSize: ticks.length, frequency,
      mostFrequent: frequency.slice(0, 3),
      leastFrequent: frequency.slice(-3).reverse(), transitions
    }, null, 2) }] };
  });

  server.registerTool('build_trade_plan', {
    description: 'Create a TradeHubz accumulator configuration from a reviewed analysis. It does not place an order.',
    inputSchema: z.object({
      symbol: z.string(),
      direction: z.enum(['UP', 'DOWN', 'NEUTRAL']),
      currentPrice: z.number().positive(),
      growthRate: z.number().min(0.01).max(0.20),
      stake: z.number().positive(),
      takeProfit: z.number().positive(),
      stopLoss: z.number().positive()
    })
  }, async input => {
    const plan = riskPlan(input);
    return { content: [{ type: 'text', text: JSON.stringify({
      ...plan,
      market: DISPLAY_NAMES[input.symbol] ?? input.symbol,
      entryPrice: input.currentPrice,
      contractType: 'ACCU',
      execution: 'MANUAL_CONFIRMATION_REQUIRED'
    }, null, 2) }] };
  });

  return server;
}

const mcpHandler = toNodeHandler(createMcpHandler(buildServer));

function setHeaders(res: import('node:http').ServerResponse) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Mcp-Session-Id, Last-Event-ID');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, Last-Event-ID');
}

const httpServer = createServer(async (req, res) => {
  setHeaders(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ service: 'tradehubz-market-analysis', status: 'ok', mcp: '/mcp' }));
    return;
  }

  if (!req.url?.startsWith('/mcp')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  if (MCP_API_KEY && req.headers.authorization !== 'Bearer ' + MCP_API_KEY) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  try {
    await mcpHandler(req, res);
  } catch (error) {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'MCP request failed' }));
    }
  }
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log('TradeHubz MCP server listening on 0.0.0.0:' + PORT);
});
