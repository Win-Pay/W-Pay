import {
  Body,
  Controller,
  Get,
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
import { randomBytes } from "node:crypto";
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
import {
  CurrentUser,
  Public,
  ZodPipe,
  type AuthUser,
} from "../common";

const NONCE_TTL_MS = 10 * 60 * 1000;

export interface AuthSession {
  accessToken: string;
  expiresIn: number;
  user: {
    id: string;
    email: string;
    role: string;
    stellarAddress: string | null;
    displayName: string | null;
  };
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private async session(user: {
    id: string;
    email: string;
    role: string;
    stellarAddress: string | null;
    displayName: string | null;
  }): Promise<AuthSession> {
    const expiresIn = 3600;
    const accessToken = await this.jwt.signAsync(
      { sub: user.id, email: user.email, role: user.role, address: user.stellarAddress },
      { expiresIn },
    );
    return {
      accessToken,
      expiresIn,
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
    const existing = await this.prisma.user.findUnique({ where: { email: input.email } });
    if (existing) throw new UnauthorizedException("email already registered");
    const passwordHash = await bcrypt.hash(input.password, 12);
    const user = await this.prisma.user.create({
      data: {
        email: input.email.toLowerCase(),
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
      valid = keypair.verify(
        Buffer.from(message, "utf8"),
        Buffer.from(input.signature, "base64"),
      );
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
