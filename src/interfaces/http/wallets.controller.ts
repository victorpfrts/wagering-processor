import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { OpenWallet } from '../../application/open-wallet.ts';
import { WageringQueries } from '../../application/queries.ts';
import { presentLedgerPage, presentWallet } from './presenters.ts';
import { ledgerQuerySchema, openWalletSchema, parseOrThrow, uuidParamSchema } from './schemas.ts';

@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly openWallet: OpenWallet,
    private readonly queries: WageringQueries,
  ) {}

  @Post()
  @HttpCode(201)
  async open(
    @Headers('x-correlation-id') correlationIdHeader: string | undefined,
    @Body() rawBody: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    const body = parseOrThrow(openWalletSchema, rawBody, 'request body');
    // preenchido pelo middleware requestContext; o fallback cobre uso direto do controller
    const correlationId = correlationIdHeader ?? Bun.randomUUIDv7();
    const wallet = await this.openWallet.execute({ ...body, correlationId });
    response.setHeader('Location', `/wallets/${wallet.id}`);
    return presentWallet(wallet);
  }

  @Get(':walletId')
  async get(@Param('walletId') rawId: string) {
    const walletId = parseOrThrow(uuidParamSchema, rawId, 'walletId');
    return presentWallet(await this.queries.getWallet(walletId));
  }

  @Get(':walletId/ledger')
  async ledger(@Param('walletId') rawId: string, @Query() rawQuery: unknown) {
    const walletId = parseOrThrow(uuidParamSchema, rawId, 'walletId');
    const query = parseOrThrow(ledgerQuerySchema, rawQuery, 'query string');
    return presentLedgerPage(await this.queries.getLedger(walletId, query.cursor, query.limit));
  }

  /** POST porque dispara verificação, log e métrica; devolve 200 mesmo com divergência. */
  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconcile(@Param('walletId') rawId: string) {
    const walletId = parseOrThrow(uuidParamSchema, rawId, 'walletId');
    return this.queries.reconcile(walletId);
  }
}
