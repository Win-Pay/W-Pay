import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  HttpException,
  Inject,
  Injectable,
  Module,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { ApiTags } from "@nestjs/swagger";
import bcrypt from "bcryptjs";
import { Keypair } from "@stellar/stellar-sdk";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import {
  WalletChallengeSchema,
  WalletVerifySchema,
  LoginSchema,
  RegisterSchema,
  type LoginInput,
  type RegisterInput,
  type WalletVerifyInput,
} from "@wpay/types";
import { buildWalletAuthMessage } from "@wpay/shared";
import { APP_CONFIG, type AppConfig } from "../config";
import { PrismaService } from "../prisma.service";
import { LoginThrottle } from "../login-throttle";
import {
  CurrentUser,
  Public,
  ZodPipe,
  type AuthUser,
} from "../common";

const NONCE_TTL_MS = 10 * 60 * 1000;
export const REFRESH_COOKIE = "wpay_refresh";
export const CSRF_COOKIE = "wpay_csrf";
export const CSRF_HEADER = "x-csrf-token";

type SessionUser = {
  id: string;
  email: string;
  role: string;
  stellarAddress: string | null;
  displayName: string | null;
};

/** Response body returned to browsers. The refresh token never appears here. */
export interface AuthSession {
  accessToken: string;
  expiresIn: number;
  refreshExpiresIn: number;
  csrfToken: string;
  user: SessionUser;
}

interface IssuedSession extends Omit<AuthSession, "csrfToken"> {
  refreshToken: string;
}

function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const entry of header.split(";")) {
    const separator = entry.indexOf("=");
    if (separator === -1) continue;
    if (entry.slice(0, separator).trim() === name) {
      try {
        return decodeURIComponent(entry.slice(separator + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function csrfMatches(cookieValue: string | undefined, headerValue: string | undefined): boolean {
  if (!cookieValue || !headerValue) return false;
  const left = Buffer.from(cookieValue);
  const right = Buffer.from(headerValue);
  return left.length === right.length && timingSafeEqual(left, right);
}

function parseDurationSeconds(value: string, fallback: number): number {
  const match = /^(\d+)([smhd])?$/.exec(value.trim());
  if (!match) return fallback;
  const amount = Number(match[1]);
  if (match[2] === "d") return amount * 86_400;
  if (match[2] === "h") return amount * 3_600;
  if (match[2] === "m") return amount * 60;
  return amount;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

@Injectable()
export class AuthService {
  private readonly throttle: LoginThrottle;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.throttle = new LoginThrottle(this.config.env);
  }

  private async accessToken(user: SessionUser): Promise<{ accessToken: string; expiresIn: number }> {
    const expiresIn = parseDurationSeconds(this.config.env.JWT_EXPIRES_IN, 3_600);
    const accessToken = await this.jwt.signAsync(
      { sub: user.id, email: user.email, role: user.role, address: user.stellarAddress },
      { expiresIn },
    );
    return { accessToken, expiresIn };
  }

  private refreshExpiry(): { expiresAt: Date; refreshExpiresIn: number } {
    const refreshExpiresIn = this.config.env.JWT_REFRESH_TTL_DAYS * 86_400;
    return { expiresAt: new Date(Date.now() + refreshExpiresIn * 1_000), refreshExpiresIn };
  }

  private async session(user: SessionUser): Promise<IssuedSession> {
    const access = await this.accessToken(user);
    const refreshToken = randomBytes(48).toString("base64url");
    const { expiresAt, refreshExpiresIn } = this.refreshExpiry();
    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(refreshToken),
        familyId: randomBytes(16).toString("hex"),
        expiresAt,
      },
    });
    return {
      ...access,
      refreshToken,
      refreshExpiresIn,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        stellarAddress: user.stellarAddress,
        displayName: user.displayName,
      },
    };
  }

  async register(input: RegisterInput): Promise<IssuedSession> {
    const email = input.email.toLowerCase();
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) throw new UnauthorizedException("email already registered");
    const passwordHash = await bcrypt.hash(input.password, 12);
    const user = await this.prisma.user.create({
      data: {
        email,
        passwordHash,
        displayName: input.displayName ?? null,
        role: "USER",
      },
    });
    return this.session(user);
  }

  async login(input: LoginInput): Promise<IssuedSession> {
    const email = input.email.toLowerCase();
    const throttle = await this.throttle.record(email);
    if (throttle.locked) {
      throw new HttpException(
        {
          statusCode: 429,
          code: "ACCOUNT_LOCKED",
          message: "too many failed sign-in attempts; try again later",
          retryAfter: throttle.retryAfterSeconds,
        },
        429,
      );
    }
    const user = await this.prisma.user.findUnique({ where: { email } });
    // Compare against a dummy hash when the user is missing so timing does not
    // reveal whether an email exists.
    const hash = user?.passwordHash ?? "$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin";
    const valid = await bcrypt.compare(input.password, hash);
    if (!user || !valid) throw new UnauthorizedException("invalid email or password");
    await this.throttle.reset(email);
    return this.session(user);
  }

  /**
   * Rotates a refresh token. Only the hash is stored, and a token that was
   * already rotated is treated as stolen: the entire token family is revoked
   * rather than issuing a new session.
   */
  async refresh(refreshToken: string): Promise<IssuedSession> {
    const tokenHash = hashToken(refreshToken);
    const record = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });
    if (!record) throw new UnauthorizedException("invalid refresh token");
    if (record.revokedAt) {
      await this.revokeFamily(record.familyId);
      throw new UnauthorizedException("refresh token reuse detected");
    }
    if (record.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException("refresh token expired");
    }

    const nextToken = randomBytes(48).toString("base64url");
    const nextHash = hashToken(nextToken);
    const { expiresAt } = this.refreshExpiry();
    const rotated = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.refreshToken.updateMany({
        where: { id: record.id, revokedAt: null, expiresAt: { gt: new Date() } },
        data: { revokedAt: new Date(), replacedByHash: nextHash },
      });
      if (claimed.count === 0) return false;
      await tx.refreshToken.create({
        data: {
          userId: record.userId,
          tokenHash: nextHash,
          familyId: record.familyId,
          expiresAt,
        },
      });
      return true;
    });
    if (!rotated) {
      await this.revokeFamily(record.familyId);
      throw new UnauthorizedException("refresh token reuse detected");
    }

    const access = await this.accessToken(record.user);
    return {
      ...access,
      refreshToken: nextToken,
      refreshExpiresIn: this.config.env.JWT_REFRESH_TTL_DAYS * 86_400,
      user: {
        id: record.user.id,
        email: record.user.email,
        role: record.user.role,
        stellarAddress: record.user.stellarAddress,
        displayName: record.user.displayName,
      },
    };
  }

  /** Revoking an opaque token is idempotent; ownership is proven by the token. */
  async logout(refreshToken: string | undefined): Promise<{ revoked: true }> {
    if (refreshToken) {
      const tokenHash = hashToken(refreshToken);
      await this.prisma.refreshToken.updateMany({
        where: { tokenHash, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    return { revoked: true };
  }

  async logoutAll(userId: string): Promise<{ revoked: true }> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { revoked: true };
  }

  private async revokeFamily(familyId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async challenge(address: string): Promise<{ nonce: string; message: string; expiresAt: string }> {
    const nonce = randomBytes(24).toString("hex");
    const expiresAt = new Date(Date.now() + NONCE_TTL_MS);
    const record = await this.prisma.walletNonce.create({
      data: { address, nonce, expiresAt },
    });
    return {
      nonce,
      message: this.message(address, nonce, record.createdAt.toISOString()),
      expiresAt: expiresAt.toISOString(),
    };
  }

  async verifyWallet(input: WalletVerifyInput): Promise<IssuedSession> {
    const record = await this.prisma.walletNonce.findUnique({ where: { nonce: input.nonce } });
    if (!record || record.address !== input.address) {
      throw new UnauthorizedException("unknown wallet challenge");
    }
    if (record.usedAt) throw new UnauthorizedException("challenge already used");
    if (record.expiresAt.getTime() < Date.now()) throw new UnauthorizedException("challenge expired");

    const message = this.message(input.address, record.nonce, record.createdAt.toISOString());
    let valid = false;
    try {
      const keypair = Keypair.fromPublicKey(input.address);
      const signature = Buffer.from(input.signature, "base64");
      const raw = Buffer.from(message, "utf8");
      // Freighter signs messages per SEP-53 (SHA-256 of a prefixed message).
      // Accept both forms so browser wallets and CLI keypairs can authenticate.
      const sep53 = createHash("sha256")
        .update(Buffer.concat([Buffer.from("Stellar Signed Message:\n", "utf8"), raw]))
        .digest();
      valid = keypair.verify(raw, signature) || keypair.verify(sep53, signature);
    } catch {
      valid = false;
    }
    if (!valid) throw new UnauthorizedException("invalid wallet signature");

    await this.prisma.walletNonce.update({
      where: { id: record.id },
      data: { usedAt: new Date() },
    });

    const existing = await this.prisma.user.findUnique({
      where: { stellarAddress: input.address },
    });
    const user =
      existing ??
      (await this.prisma.user.create({
        data: {
          email: `wallet_${input.address.slice(0, 16)}@wpay.local`,
          passwordHash: await bcrypt.hash(randomBytes(24).toString("hex"), 10),
          stellarAddress: input.address,
          role: "USER",
        },
      }));
    if (this.config.adminAddresses.includes(input.address) && user.role !== "ADMIN") {
      await this.prisma.user.update({ where: { id: user.id }, data: { role: "ADMIN" } });
      user.role = "ADMIN";
    }
    return this.session(user);
  }

  private message(address: string, nonce: string, issuedAt: string): string {
    const domain = new URL(this.config.env.API_PUBLIC_URL).host;
    return buildWalletAuthMessage({ domain, address, nonce, issuedAt });
  }
}

@ApiTags("auth")
@Controller("auth")
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private newCsrfToken(): string {
    return randomBytes(32).toString("base64url");
  }

  private refreshCookie(maxAgeMs: number) {
    return {
      httpOnly: true,
      secure: this.config.cookies.secure,
      sameSite: this.config.cookies.sameSite,
      domain: this.config.cookies.domain,
      path: "/v1/auth",
      maxAge: maxAgeMs,
    };
  }

  private csrfCookie(maxAgeMs: number) {
    return {
      httpOnly: true,
      secure: this.config.cookies.secure,
      sameSite: this.config.cookies.sameSite,
      domain: this.config.cookies.domain,
      path: "/",
      maxAge: maxAgeMs,
    };
  }

  private writeSession(response: Response, issued: IssuedSession, csrfToken: string): AuthSession {
    const { refreshToken, ...session } = issued;
    const maxAgeMs = issued.refreshExpiresIn * 1_000;
    response.cookie(REFRESH_COOKIE, refreshToken, this.refreshCookie(maxAgeMs));
    response.cookie(CSRF_COOKIE, csrfToken, this.csrfCookie(maxAgeMs));
    return { ...session, csrfToken };
  }

  private clearSession(response: Response): void {
    response.clearCookie(REFRESH_COOKIE, this.refreshCookie(0));
    response.clearCookie(CSRF_COOKIE, this.csrfCookie(0));
  }

  private assertCsrf(request: Request, provided: string | undefined): void {
    if (!csrfMatches(readCookie(request, CSRF_COOKIE), provided)) {
      throw new ForbiddenException("invalid csrf token");
    }
  }

  @Public()
  @Post("register")
  async register(
    @Body(new ZodPipe(RegisterSchema)) input: RegisterInput,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthSession> {
    return this.writeSession(response, await this.auth.register(input), this.newCsrfToken());
  }

  @Public()
  @Post("login")
  async login(
    @Body(new ZodPipe(LoginSchema)) input: LoginInput,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthSession> {
    return this.writeSession(response, await this.auth.login(input), this.newCsrfToken());
  }

  @Public()
  @Get("csrf")
  csrf(@Res({ passthrough: true }) response: Response): { csrfToken: string } {
    const csrfToken = this.newCsrfToken();
    const maxAgeMs = this.config.env.JWT_REFRESH_TTL_DAYS * 86_400_000;
    response.cookie(CSRF_COOKIE, csrfToken, this.csrfCookie(maxAgeMs));
    return { csrfToken };
  }

  @Public()
  @HttpCode(200)
  @Post("refresh")
  async refresh(
    @Req() request: Request,
    @Headers(CSRF_HEADER) csrf: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthSession> {
    const refreshToken = readCookie(request, REFRESH_COOKIE);
    if (!refreshToken) throw new UnauthorizedException("no refresh session");
    this.assertCsrf(request, csrf);
    return this.writeSession(response, await this.auth.refresh(refreshToken), this.newCsrfToken());
  }

  @Public()
  @HttpCode(200)
  @Post("logout")
  async logout(
    @Req() request: Request,
    @Headers(CSRF_HEADER) csrf: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ revoked: true }> {
    const refreshToken = readCookie(request, REFRESH_COOKIE);
    if (refreshToken) this.assertCsrf(request, csrf);
    const result = await this.auth.logout(refreshToken);
    this.clearSession(response);
    return result;
  }

  @HttpCode(200)
  @Post("logout-all")
  async logoutAll(
    @CurrentUser() user: AuthUser,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ revoked: true }> {
    const result = await this.auth.logoutAll(user.id);
    this.clearSession(response);
    return result;
  }

  @Public()
  @Post("wallet/challenge")
  challenge(
    @Body(new ZodPipe(WalletChallengeSchema)) input: { address: string },
  ): Promise<{ nonce: string; message: string; expiresAt: string }> {
    return this.auth.challenge(input.address);
  }

  @Public()
  @Post("wallet/verify")
  async verify(
    @Body(new ZodPipe(WalletVerifySchema)) input: WalletVerifyInput,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthSession> {
    return this.writeSession(response, await this.auth.verifyWallet(input), this.newCsrfToken());
  }

  @Get("me")
  me(@CurrentUser() user: AuthUser): AuthUser {
    return user;
  }
}

@Module({ controllers: [AuthController], providers: [AuthService] })
export class AuthModule {}
