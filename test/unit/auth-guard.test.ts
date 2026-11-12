import 'reflect-metadata';
import { describe, expect, test } from 'bun:test';
import { type ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  AnonymousProviderIdentity,
  ProviderAuthGuard,
  type ProviderIdentityPort,
  Public,
} from '../../src/interfaces/http/auth.ts';

class Routes {
  @Public()
  health(): void {}
  submit(): void {}
}

function contextFor(handler: keyof Routes, request: object): ExecutionContext {
  return {
    getHandler: () => Routes.prototype[handler],
    getClass: () => Routes,
    switchToHttp: () => ({ getRequest: () => ({ params: {}, ...request }) }),
  } as unknown as ExecutionContext;
}

const identityOf = (providerId: string | undefined, required = true): ProviderIdentityPort => ({
  required,
  identify: () => Promise.resolve({ providerId }),
});

const guard = (identity: ProviderIdentityPort) => new ProviderAuthGuard(new Reflector(), identity);

describe('ProviderAuthGuard (ponto de extensão da autenticação)', () => {
  test('implementação atual (no-op) deixa tudo passar', async () => {
    const noop = guard(new AnonymousProviderIdentity());
    expect(await noop.canActivate(contextFor('submit', { body: { providerId: 'a' } }))).toBe(true);
  });

  test('com um IdP ligado: anônimo recebe 401, exceto em rota pública', async () => {
    const withIdp = guard(identityOf(undefined));
    await expect(withIdp.canActivate(contextFor('submit', {}))).rejects.toThrow(
      UnauthorizedException,
    );
    expect(await withIdp.canActivate(contextFor('health', {}))).toBe(true);
  });

  test('com um IdP ligado: provedor só age em seu próprio nome', async () => {
    const asProviderA = guard(identityOf('provider-a'));
    expect(
      await asProviderA.canActivate(contextFor('submit', { body: { providerId: 'provider-a' } })),
    ).toBe(true);
    await expect(
      asProviderA.canActivate(contextFor('submit', { body: { providerId: 'provider-b' } })),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      asProviderA.canActivate(contextFor('submit', { params: { providerId: 'provider-b' } })),
    ).rejects.toThrow(ForbiddenException);
  });
});
