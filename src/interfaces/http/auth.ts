import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

/**
 * PONTO DE EXTENSÃO DA AUTENTICAÇÃO (seção 2 do desafio).
 *
 * A autenticação não foi implementada — decisão documentada no
 * ARCHITECTURE.md. O que existe aqui é o encaixe: um guard global que já
 * roda em toda rota e uma porta que hoje devolve "anônimo".
 *
 * Para ligar um Identity Provider (Keycloak, Zitadel): implementar
 * ProviderIdentityPort validando o JWT do header Authorization (assinatura
 * via JWKS, issuer, audience, expiração) e devolvendo o providerId da claim.
 * Nenhum controller muda.
 */
export interface ProviderIdentity {
  /** Provedor autenticado; undefined = requisição anônima. */
  providerId: string | undefined;
}

export interface ProviderIdentityPort {
  /** Lança se a credencial for inválida; devolve anônimo se a autenticação estiver desligada. */
  identify(request: Request): Promise<ProviderIdentity>;
  /** true = requisição anônima é recusada com 401. */
  readonly required: boolean;
}

export const PROVIDER_IDENTITY = Symbol('ProviderIdentityPort');

/** Implementação no-op: autenticação desligada, todos passam como anônimos. */
export class AnonymousProviderIdentity implements ProviderIdentityPort {
  readonly required = false;

  identify(): Promise<ProviderIdentity> {
    return Promise.resolve({ providerId: undefined });
  }
}

const IS_PUBLIC = 'isPublic';
/** Marca rotas que nunca exigem autenticação (health checks). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

@Injectable()
export class ProviderAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(PROVIDER_IDENTITY) private readonly identity: ProviderIdentityPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const { providerId } = await this.identity.identify(request);
    if (providerId === undefined) {
      if (this.identity.required) throw new UnauthorizedException();
      return true;
    }

    // Um provedor só age em seu próprio nome: o providerId do corpo ou da
    // rota precisa ser o do token.
    const claimed =
      (request.body as { providerId?: unknown } | undefined)?.providerId ??
      request.params['providerId'];
    if (claimed !== undefined && claimed !== providerId) {
      throw new ForbiddenException('providerId does not match the authenticated provider');
    }
    return true;
  }
}
