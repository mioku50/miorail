import { Router } from 'express';
import { StockBriefInputV1Schema } from '@mioagent/rwa-market-reality/stock-brief';
import { sessionWalletV1 } from '../lib/sessionWallet.js';
import { readMyStocksTodayV1 } from '../lib/stockBriefRead.js';
import {
  measureMyStockCashOutV1,
  StockPositionQuoteErrorV1,
} from '../lib/stockPositionQuoteRead.js';

export const stocksTodayRouter = Router();
stocksTodayRouter.get('/today', async (req, res) => {
  const wallet = sessionWalletV1(req, res);
  res.set('Cache-Control', 'private, no-store');
  if (!wallet) return;
  const input = StockBriefInputV1Schema.safeParse(req.query);
  if (!input.success) {
    res.status(400).json({ code: 'stock_brief_input_invalid' });
    return;
  }
  try {
    res.json(await readMyStocksTodayV1(wallet, input.data.since));
  } catch (error) {
    const badWindow = error instanceof Error && error.message === 'stock_brief_since_invalid';
    res
      .status(badWindow ? 400 : 503)
      .json({ code: badWindow ? 'stock_brief_since_invalid' : 'stock_brief_unread' });
  }
});

stocksTodayRouter.post('/cash-out', async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  const wallet = sessionWalletV1(req, res);
  if (!wallet) return;
  try {
    res.json(await measureMyStockCashOutV1(wallet, req.body));
  } catch (error) {
    const known = error instanceof StockPositionQuoteErrorV1 ? error : null;
    if (known?.status === 429) res.set('Retry-After', '60');
    res
      .status(known?.status ?? 503)
      .json({
        error: known?.code ?? 'stock_cash_out_measurement_unread',
        code: known?.code ?? 'stock_cash_out_measurement_unread',
      });
  }
});
