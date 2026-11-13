import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Injectable,
  Module,
  Post,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { ApiTags } from "@nestjs/swagger";
import bcrypt from "bcryptjs";
import { Keypair } from "@stellar/stellar-sdk";
import { createHash, randomBytes } from "node:crypto";
import {
  RefreshTokenSchema,
  WalletChallengeSchema,
  WalletVerifySchema,
  LoginSchema,
  RegisterSchema,
  type LoginInput,
  type RefreshTokenInput,
  type RegisterInput,
  type WalletVerifyInput,
} from "@wpay/types";
import { buildWalletAuthMessage } from "@wpay/shared";
import { APP_CONFIG, type AppConfig } from "../config";
import { PrismaService } from "../prisma.service";
import {
  CurrentUser,
  Public,
  ZodPipe,
  type AuthUser,
} from "../common";

const NONCE_TTL_MS = 10 * 60 * 1000;

type SessionUser = {
  id: string;
  email: string;
  role: string;
  stellarAddress: string | null;
  displayName: string | null;
};

export interface AuthSession {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshExpiresIn: number;
  user: SessionUser;
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

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

  private async session(user: SessionUser): Promise<AuthSession> {
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

  async register(input: RegisterInput): Promise<AuthSession> {
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

  async login(input: LoginInput): Promise<AuthSession> {
    const user = await this.prisma.user.findUnique({ where: { email: input.email.toLowerCase() } });
    // Compare against a dummy hash when the user is missing so timing does not
    // reveal whether an email exists.
    const hash = user?.passwordHash ?? "$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin";
    const valid = await bcrypt.compare(input.password, hash);
    if (!user || !valid) throw new UnauthorizedException("invalid email or password");
    return this.session(user);
  }

  /**
   * Rotates a refresh token. Only the hash is stored, and a token that was
   * already rotated is treated as stolen: the entire token family is revoked
   * rather than issuing a new session.
   */
  async refresh(input: RefreshTokenInput): Promise<AuthSession> {
    const tokenHash = hashToken(input.refreshToken);
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
  async logout(input: RefreshTokenInput): Promise<{ revoked: true }> {
    const tokenHash = hashToken(input.refreshToken);
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
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

  async verifyWallet(input: WalletVerifyInput): Promise<AuthSession> {
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
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post("register")
  register(@Body(new ZodPipe(RegisterSchema)) input: RegisterInput): Promise<AuthSession> {
    return this.auth.register(input);
  }

  @Public()
  @Post("login")
  login(@Body(new ZodPipe(LoginSchema)) input: LoginInput): Promise<AuthSession> {
    return this.auth.login(input);
  }

  @Public()
  @HttpCode(200)
  @Post("refresh")
  refresh(@Body(new ZodPipe(RefreshTokenSchema)) input: RefreshTokenInput): Promise<AuthSession> {
    return this.auth.refresh(input);
  }

  @Public()
  @HttpCode(200)
  @Post("logout")
  logout(@Body(new ZodPipe(RefreshTokenSchema)) input: RefreshTokenInput): Promise<{ revoked: true }> {
    return this.auth.logout(input);
  }

  @HttpCode(200)
  @Post("logout-all")
  logoutAll(@CurrentUser() user: AuthUser): Promise<{ revoked: true }> {
    return this.auth.logoutAll(user.id);
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
  verify(@Body(new ZodPipe(WalletVerifySchema)) input: WalletVerifyInput): Promise<AuthSession> {
    return this.auth.verifyWallet(input);
  }

  @Get("me")
  me(@CurrentUser() user: AuthUser): AuthUser {
    return user;
  }
}

@Module({ controllers: [AuthController], providers: [AuthService] })
export class AuthModule {}
