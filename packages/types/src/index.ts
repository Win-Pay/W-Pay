/**
 * Shared domain types and request schemas.
 *
 * Amounts are always decimal strings of stroops (1 XLM = 10^7 stroops). They are
 * strings rather than numbers because Soroban amounts are i128 and JavaScript
 * numbers lose precision above 2^53.
 */
import { z } from "zod";

export const I128_MAX = 170141183460469231731687303715884105727n;

/** Non-negative integer amount as a decimal string, bounded by i128. */
export const AmountSchema = z
  .string()
  .regex(/^\d{1,39}$/, "amount must be a non-negative integer string")
  .refine((value) => BigInt(value) <= I128_MAX, "amount exceeds i128 range");

export const PositiveAmountSchema = AmountSchema.refine(
  (value) => BigInt(value) > 0n,
  "amount must be greater than zero",
);

/** Stellar account (G...) or contract (C...) address. */
export const StellarAddressSchema = z
  .string()
  .regex(/^[GC][A-Z2-7]{55}$/, "invalid Stellar address");

export const TxHashSchema = z.string().regex(/^[0-9a-f]{64}$/i, "invalid transaction hash");

export const PaginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});

export type Pagination = z.infer<typeof PaginationSchema>;

export const merchantStatuses = ["PENDING", "ACTIVE", "SUSPENDED", "CLOSED"] as const;
export const MerchantStatusSchema = z.enum(merchantStatuses);
export type MerchantStatus = z.infer<typeof MerchantStatusSchema>;

export const paymentStatuses = [
  "PENDING",
  "SETTLED",
  "PARTIALLY_REFUNDED",
  "REFUNDED",
  "FAILED",
] as const;
export const PaymentStatusSchema = z.enum(paymentStatuses);
export type PaymentStatus = z.infer<typeof PaymentStatusSchema>;

export const invoiceStatuses = ["OPEN", "PAID", "CANCELLED", "EXPIRED"] as const;
export const InvoiceStatusSchema = z.enum(invoiceStatuses);
export type InvoiceStatus = z.infer<typeof InvoiceStatusSchema>;

export const escrowStatuses = [
  "CREATED",
  "FUNDED",
  "RELEASED",
  "REFUNDED",
  "DISPUTED",
  "RESOLVED",
] as const;
export const EscrowStatusSchema = z.enum(escrowStatuses);
export type EscrowStatus = z.infer<typeof EscrowStatusSchema>;

export const refundStatuses = ["PENDING", "APPROVED", "REJECTED"] as const;
export const RefundStatusSchema = z.enum(refundStatuses);
export type RefundStatus = z.infer<typeof RefundStatusSchema>;

export const subscriptionStatuses = ["ACTIVE", "CANCELLED", "LAPSED"] as const;
export const SubscriptionStatusSchema = z.enum(subscriptionStatuses);
export type SubscriptionStatus = z.infer<typeof SubscriptionStatusSchema>;

export const userRoles = ["USER", "MERCHANT", "OPERATOR", "ADMIN"] as const;
export const UserRoleSchema = z.enum(userRoles);
export type UserRole = z.infer<typeof UserRoleSchema>;

export const webhookEvents = [
  "payment.settled",
  "payment.refunded",
  "invoice.paid",
  "invoice.expired",
  "escrow.released",
  "escrow.disputed",
  "refund.requested",
  "refund.approved",
  "subscription.charged",
  "merchant.status_changed",
] as const;
export const WebhookEventSchema = z.enum(webhookEvents);
export type WebhookEvent = z.infer<typeof WebhookEventSchema>;

const email = z.string().email().max(320);
const password = z.string().min(10).max(128);

export const RegisterSchema = z.object({
  email,
  password,
  displayName: z.string().min(1).max(80).optional(),
});
export type RegisterInput = z.infer<typeof RegisterSchema>;

export const LoginSchema = z.object({ email, password });
export type LoginInput = z.infer<typeof LoginSchema>;

export const RefreshTokenSchema = z.object({
  refreshToken: z.string().min(32).max(256),
});
export type RefreshTokenInput = z.infer<typeof RefreshTokenSchema>;

export const WalletChallengeSchema = z.object({
  address: StellarAddressSchema,
});
export type WalletChallengeInput = z.infer<typeof WalletChallengeSchema>;

export const WalletVerifySchema = z.object({
  address: StellarAddressSchema,
  nonce: z.string().min(16).max(128),
  signature: z.string().min(16).max(256),
});
export type WalletVerifyInput = z.infer<typeof WalletVerifySchema>;

export const CreateMerchantSchema = z.object({
  name: z.string().min(1).max(64),
  ownerAddress: StellarAddressSchema,
  settlementAddress: StellarAddressSchema,
  feeBps: z.number().int().min(0).max(1000).default(250),
  website: z.string().url().max(200).optional(),
  description: z.string().max(500).optional(),
});
export type CreateMerchantInput = z.infer<typeof CreateMerchantSchema>;

export const UpdateMerchantSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  settlementAddress: StellarAddressSchema.optional(),
  website: z.string().url().max(200).nullable().optional(),
  description: z.string().max(500).nullable().optional(),
});
export type UpdateMerchantInput = z.infer<typeof UpdateMerchantSchema>;

export const CreatePaymentSchema = z.object({
  merchantId: z.string().min(1),
  token: StellarAddressSchema,
  amount: PositiveAmountSchema,
  memo: z.string().max(64).optional(),
  payerAddress: StellarAddressSchema.optional(),
});
export type CreatePaymentInput = z.infer<typeof CreatePaymentSchema>;

export const ConfirmPaymentSchema = z.object({
  txHash: TxHashSchema,
  contractPaymentId: z.string().regex(/^\d+$/).optional(),
});
export type ConfirmPaymentInput = z.infer<typeof ConfirmPaymentSchema>;

export const PayInvoiceIntentSchema = z.object({
  payer: StellarAddressSchema,
});
export type PayInvoiceIntentInput = z.infer<typeof PayInvoiceIntentSchema>;

export const CreateInvoiceSchema = z.object({
  merchantId: z.string().min(1),
  token: StellarAddressSchema,
  amount: PositiveAmountSchema,
  memo: z.string().max(64).optional(),
  dueAt: z.coerce.date(),
  customerEmail: email.optional(),
});
export type CreateInvoiceInput = z.infer<typeof CreateInvoiceSchema>;

export const CreateEscrowSchema = z.object({
  merchantId: z.string().min(1),
  payerAddress: StellarAddressSchema,
  payeeAddress: StellarAddressSchema,
  arbiterAddress: StellarAddressSchema,
  token: StellarAddressSchema,
  amount: PositiveAmountSchema,
  releaseAt: z.coerce.date(),
});
export type CreateEscrowInput = z.infer<typeof CreateEscrowSchema>;

export const RequestRefundSchema = z.object({
  paymentId: z.string().min(1),
  amount: PositiveAmountSchema,
  reason: z.string().min(1).max(128),
});
export type RequestRefundInput = z.infer<typeof RequestRefundSchema>;

export const CreatePlanSchema = z.object({
  merchantId: z.string().min(1),
  token: StellarAddressSchema,
  amount: PositiveAmountSchema,
  intervalSecs: z.number().int().min(60),
});
export type CreatePlanInput = z.infer<typeof CreatePlanSchema>;

export const SubscribeSchema = z.object({
  planId: z.string().min(1),
  subscriber: StellarAddressSchema,
  cycles: z.number().int().min(1).max(120),
});
export type SubscribeInput = z.infer<typeof SubscribeSchema>;

export const CreateWebhookSchema = z.object({
  merchantId: z.string().min(1),
  url: z.string().url().max(500),
  events: z.array(WebhookEventSchema).min(1),
});
export type CreateWebhookInput = z.infer<typeof CreateWebhookSchema>;

export const CreateApiKeySchema = z.object({
  name: z.string().min(1).max(60),
  merchantId: z.string().optional(),
});
export type CreateApiKeyInput = z.infer<typeof CreateApiKeySchema>;

export interface MerchantRecord {
  id: string;
  registryId: string | null;
  name: string;
  ownerAddress: string;
  settlementAddress: string;
  feeBps: number;
  status: MerchantStatus;
  website: string | null;
  description: string | null;
  createdAt: string;
}

export interface PaymentRecord {
  id: string;
  merchantId: string;
  payerAddress: string;
  token: string;
  amount: string;
  fee: string;
  net: string;
  refunded: string;
  status: PaymentStatus;
  memo: string | null;
  txHash: string | null;
  contractPaymentId: string | null;
  createdAt: string;
  settledAt: string | null;
}

export interface InvoiceRecord {
  id: string;
  number: string;
  merchantId: string;
  token: string;
  amount: string;
  memo: string | null;
  status: InvoiceStatus;
  dueAt: string;
  paidAt: string | null;
  paymentId: string | null;
  contractInvoiceId: string | null;
  contractPaymentId: string | null;
  txHash: string | null;
  customerEmail: string | null;
  createdAt: string;
}

export interface EscrowRecord {
  id: string;
  merchantId: string;
  payerAddress: string;
  payeeAddress: string;
  arbiterAddress: string;
  token: string;
  amount: string;
  releaseAt: string;
  status: EscrowStatus;
  contractEscrowId: string | null;
  createdAt: string;
}

export interface RefundRecord {
  id: string;
  paymentId: string;
  merchantId: string;
  payerAddress: string;
  amount: string;
  reason: string;
  status: RefundStatus;
  contractRefundId: string | null;
  txHash: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface SubscriptionPlanRecord {
  id: string;
  merchantId: string;
  token: string;
  amount: string;
  intervalSecs: number;
  active: boolean;
  planIdOnChain: string | null;
  createdAt: string;
}

export interface SubscriptionRecord {
  id: string;
  planId: string;
  subscriber: string;
  prepaid: string;
  cyclesCharged: number;
  nextDueAt: string;
  status: SubscriptionStatus;
  createdAt: string;
}

/** Envelope returned by every list endpoint. */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface ApiErrorBody {
  statusCode: number;
  code: string;
  message: string;
  details?: unknown;
  requestId?: string;
}

/** Unsigned transaction the client must sign and submit. */
export interface TransactionIntent {
  xdr: string;
  networkPassphrase: string;
  contractId: string;
  method: string;
  description: string;
  /** Set when the intent is tied to a pending database row (e.g. an invoice). */
  paymentId?: string;
}
