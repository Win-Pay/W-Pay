import {
  ArgumentMetadata,
  BadRequestException,
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  NestMiddleware,
  PipeTransform,
  SetMetadata,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import type { Request, Response, NextFunction } from "express";
import { createHash, randomBytes } from "node:crypto";
import type { ZodSchema } from "zod";
import type { UserRole } from "@wpay/types";
import { APP_CONFIG, type AppConfig } from "./config";
import { PrismaService } from "./prisma.service";
import {
  MemoryRateLimitStore,
  RedisRateLimitStore,
  createRedisClient,
  type RateLimitStore,
} from "./rate-limit.store";

/* ------------------------------------------------------------------ */
/* Request user                                                        */
/* ------------------------------------------------------------------ */

export interface AuthUser {
  id: string;
  email: string;
  role: UserRole;
  stellarAddress: string | null;
  /** When authenticated with an API key, the merchant it is scoped to. */
  scopedMerchantId: string | null;
  viaApiKey: boolean;
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthUser => {
    const request = context.switchToHttp().getRequest<{ user?: AuthUser }>();
    if (!request.user) throw new UnauthorizedException("authentication required");
    return request.user;
  },
);

/* ------------------------------------------------------------------ */
/* Metadata + guards                                                  */
/* ------------------------------------------------------------------ */

export const IS_PUBLIC = "wpay:isPublic";
export const ROLES_KEY = "wpay:roles";

export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);
export const Roles = (...roles: UserRole[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<
      Request & { user?: AuthUser }
    >();
    const authorization = request.header("authorization");

    if (authorization?.startsWith("Bearer ")) {
      const token = authorization.slice("Bearer ".length);
      try {
        const payload = await this.jwt.verifyAsync<{
          sub: string;
          email: string;
          role: UserRole;
          address: string | null;
        }>(token, { algorithms: ["HS256"] });
        request.user = {
          id: payload.sub,
          email: payload.email,
          role: payload.role,
          stellarAddress: payload.address ?? null,
          scopedMerchantId: null,
          viaApiKey: false,
        };
        return true;
      } catch {
        throw new UnauthorizedException("invalid or expired token");
      }
    }

    const apiKey = request.header("x-api-key");
    if (apiKey) {
      const record = await this.prisma.apiKey.findFirst({
        where: { prefix: apiKeyPrefix(apiKey), keyHash: hashApiKey(apiKey), revokedAt: null },
        include: { user: true },
      });
      if (!record) throw new UnauthorizedException("invalid API key");
      const isAdminAddress =
        record.user.stellarAddress !== null &&
        this.config.adminAddresses.includes(record.user.stellarAddress);
      request.user = {
        id: record.user.id,
        email: record.user.email,
        role: isAdminAddress ? "ADMIN" : record.user.role,
        stellarAddress: record.user.stellarAddress,
        scopedMerchantId: record.merchantId,
        viaApiKey: true,
      };
      void this.prisma.apiKey.update({
        where: { id: record.id },
        data: { lastUsedAt: new Date() },
      });
      return true;
    }

    throw new UnauthorizedException("authentication required");
  }
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;
    const request = context.switchToHttp().getRequest<{ user?: AuthUser }>();
    const user = request.user;
    if (!user) return false;
    if (user.role === "ADMIN" || required.includes(user.role)) return true;
    throw new ForbiddenException("insufficient role");
  }
}

/* ------------------------------------------------------------------ */
/* Rate limiting (fixed window, Redis-backed with in-process fallback) */
/* ------------------------------------------------------------------ */

@Injectable()
export class RateLimitGuard implements CanActivate {
  /**
   * Counters live in Redis when REDIS_URL is set, so the quota is shared by
   * every replica. Without it the guard falls back to an in-process store,
   * which is correct for a single replica and for local development.
   */
  private readonly store: RateLimitStore;
  private readonly limit: number;
  private readonly windowMs = 60_000;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.limit = config.env.RATE_LIMIT_PER_MINUTE;
    this.store = config.env.REDIS_URL
      ? new RedisRateLimitStore(createRedisClient(config.env.REDIS_URL))
      : new MemoryRateLimitStore();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    if (request.method === "OPTIONS") return true;
    const key = request.user?.id ?? request.ip ?? "anonymous";
    const decision = await this.store.hit(key, this.windowMs);
    if (decision.count > this.limit) {
      const response = context.switchToHttp().getResponse<Response>();
      const retryAfter = Math.max(1, Math.ceil((decision.resetAt - Date.now()) / 1000));
      response.setHeader("retry-after", String(retryAfter));
      throw new HttpException(
        { statusCode: 429, code: "RATE_LIMITED", message: "too many requests", retryAfter },
        429,
      );
    }
    return true;
  }
}

/* ------------------------------------------------------------------ */
/* Validation, serialization, request logging                          */
/* ------------------------------------------------------------------ */

@Injectable()
export class ZodPipe implements PipeTransform {
  constructor(private readonly schema: ZodSchema) {}

  transform(value: unknown, _metadata: ArgumentMetadata): unknown {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        statusCode: 400,
        code: "VALIDATION_FAILED",
        message: "request validation failed",
        details: result.error.flatten(),
      });
    }
    return result.data;
  }
}

/** Converts BigInt (i128 amounts) to strings so responses serialize. */
export function serializeBigInts<T>(value: T): T {
  if (typeof value === "bigint") return value.toString() as unknown as T;
  if (Array.isArray(value)) return value.map((entry) => serializeBigInts(entry)) as unknown as T;
  if (value instanceof Date) return value as unknown as T;
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      result[key] = serializeBigInts(entry);
    }
    return result as T;
  }
  return value;
}

@Injectable()
export class RequestLogger implements NestMiddleware {
  use(request: Request, response: Response, next: NextFunction): void {
    const id = request.header("x-request-id") ?? randomBytes(8).toString("hex");
    response.setHeader("x-request-id", id);
    next();
  }
}

/* ------------------------------------------------------------------ */
/* API keys + access rules                                             */
/* ------------------------------------------------------------------ */

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function apiKeyPrefix(key: string): string {
  return key.slice(0, 12);
}

export function generateApiKey(): { key: string; prefix: string; hash: string } {
  const key = `wpay_${randomBytes(24).toString("base64url")}`;
  return { key, prefix: apiKeyPrefix(key), hash: hashApiKey(key) };
}

export interface MerchantScope {
  id: string;
  ownerUserId: string | null;
}

/**
 * Access rule shared by merchant-scoped endpoints: admins/operators see
 * everything, API keys see their merchant (or all if unscoped), and a user sees
 * the merchants they own.
 */
export function canAccessMerchant(
  user: Pick<AuthUser, "id" | "role" | "scopedMerchantId" | "viaApiKey">,
  merchant: MerchantScope,
): boolean {
  if (user.role === "ADMIN" || user.role === "OPERATOR") return true;
  if (user.viaApiKey) {
    return user.scopedMerchantId === null || user.scopedMerchantId === merchant.id;
  }
  return merchant.ownerUserId === user.id;
}

export function requireMerchantAccess(
  user: Pick<AuthUser, "id" | "role" | "scopedMerchantId" | "viaApiKey">,
  merchant: MerchantScope,
): void {
  if (!canAccessMerchant(user, merchant)) throw new ForbiddenException("merchant access denied");
}

/** Wrap a promise so a failing side effect never breaks the request. */
export function fireAndForget(promise: Promise<unknown>, onError?: (error: unknown) => void): void {
  promise.catch((error: unknown) => onError?.(error));
}
