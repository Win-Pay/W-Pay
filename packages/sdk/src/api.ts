/**
 * Typed client for the W-Pay REST API. Every method maps to one endpoint; the
 * request bodies are the schemas from `@wpay/types`.
 */
import type {
  ApiErrorBody,
  CreateApiKeyInput,
  CreateEscrowInput,
  CreateInvoiceInput,
  CreateMerchantInput,
  CreatePaymentInput,
  CreatePlanInput,
  CreateWebhookInput,
  EscrowRecord,
  InvoiceRecord,
  LoginInput,
  MerchantRecord,
  Page,
  PaymentRecord,
  RefundRecord,
  RegisterInput,
  RequestRefundInput,
  SubscribeInput,
  SubscriptionPlanRecord,
  SubscriptionRecord,
  TransactionIntent,
  UpdateMerchantInput,
  WalletVerifyInput,
} from "@wpay/types";
import { HttpClient, type ApiClientOptions, type RequestOptions } from "./http";

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

export interface WalletChallenge {
  nonce: string;
  message: string;
  expiresAt: string;
}

export interface PaymentIntentResponse {
  payment: PaymentRecord;
  transaction: TransactionIntent | null;
}

export interface EscrowIntentResponse {
  escrow: EscrowRecord;
  transaction: TransactionIntent | null;
}

export interface RefundIntentResponse {
  refund: RefundRecord;
  transaction: TransactionIntent | null;
}

export interface AnalyticsOverview {
  merchantId: string;
  grossVolume: string;
  feesPaid: string;
  refundedVolume: string;
  paymentCount: number;
  settledCount: number;
  refundCount: number;
  pendingRefunds: number;
  averagePayment: string;
  daily: Array<{ date: string; volume: string; count: number }>;
}

export interface ApiKeyRecord {
  id: string;
  name: string;
  prefix: string;
  merchantId: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  /** Present only in the creation response. */
  key?: string;
}

export interface WebhookRecord {
  id: string;
  merchantId: string;
  url: string;
  events: string[];
  active: boolean;
  createdAt: string;
  /** Present only in the creation response. */
  secret?: string;
}

export interface WebhookDeliveryRecord {
  id: string;
  endpointId: string;
  event: string;
  status: string;
  attempts: number;
  responseStatus: number | null;
  lastError: string | null;
  nextAttemptAt: string;
  createdAt: string;
  deliveredAt: string | null;
}

export interface HealthStatus {
  status: "ok" | "degraded";
  uptimeSeconds: number;
  version: string;
  database: "up" | "down";
  soroban: "configured" | "not_configured";
  contracts: Record<string, boolean>;
}

export class WPayApi {
  readonly http: HttpClient;

  constructor(options: ApiClientOptions) {
    this.http = new HttpClient(options);
  }

  setToken(token: string | undefined): void {
    this.http.setToken(token);
  }

  setApiKey(apiKey: string | undefined): void {
    this.http.setApiKey(apiKey);
  }

  auth = {
    register: (input: RegisterInput) =>
      this.http.request<AuthSession>("POST", "/v1/auth/register", input),
    login: (input: LoginInput) => this.http.request<AuthSession>("POST", "/v1/auth/login", input),
    walletChallenge: (address: string) =>
      this.http.request<WalletChallenge>("POST", "/v1/auth/wallet/challenge", { address }),
    walletVerify: (input: WalletVerifyInput) =>
      this.http.request<AuthSession>("POST", "/v1/auth/wallet/verify", input),
    me: () => this.http.request<AuthSession["user"]>("GET", "/v1/auth/me"),
  };

  merchants = {
    create: (input: CreateMerchantInput) =>
      this.http.request<MerchantRecord>("POST", "/v1/merchants", input, {
        idempotencyKey: undefined,
      }),
    list: (query: { status?: string; limit?: number; cursor?: string } = {}) =>
      this.http.requestPage<MerchantRecord>("/v1/merchants", query),
    get: (id: string) => this.http.request<MerchantRecord>("GET", `/v1/merchants/${id}`),
    update: (id: string, input: UpdateMerchantInput) =>
      this.http.request<MerchantRecord>("PATCH", `/v1/merchants/${id}`, input),
    approve: (id: string) =>
      this.http.request<{ merchant: MerchantRecord; transaction: TransactionIntent | null }>(
        "POST",
        `/v1/merchants/${id}/approve`,
      ),
    suspend: (id: string) =>
      this.http.request<{ merchant: MerchantRecord; transaction: TransactionIntent | null }>(
        "POST",
        `/v1/merchants/${id}/suspend`,
      ),
  };

  payments = {
    create: (input: CreatePaymentInput, idempotencyKey?: string) =>
      this.http.request<PaymentIntentResponse>("POST", "/v1/payments", input, {
        idempotencyKey,
      }),
    list: (query: { merchantId?: string; status?: string; limit?: number; cursor?: string } = {}) =>
      this.http.requestPage<PaymentRecord>("/v1/payments", query),
    get: (id: string) => this.http.request<PaymentRecord>("GET", `/v1/payments/${id}`),
    intent: (id: string) =>
      this.http.request<TransactionIntent>("GET", `/v1/payments/${id}/intent`),
    confirm: (id: string, txHash: string) =>
      this.http.request<PaymentRecord>("POST", `/v1/payments/${id}/confirm`, { txHash }),
  };

  invoices = {
    create: (input: CreateInvoiceInput) =>
      this.http.request<InvoiceRecord>("POST", "/v1/invoices", input),
    list: (query: { merchantId?: string; status?: string; limit?: number; cursor?: string } = {}) =>
      this.http.requestPage<InvoiceRecord>("/v1/invoices", query),
    get: (id: string) => this.http.request<InvoiceRecord>("GET", `/v1/invoices/${id}`),
    public: (number: string) =>
      this.http.request<InvoiceRecord>("GET", `/v1/invoices/public/${number}`),
    cancel: (id: string) => this.http.request<InvoiceRecord>("POST", `/v1/invoices/${id}/cancel`),
    payIntent: (number: string, payer: string) =>
      this.http.request<TransactionIntent>("POST", `/v1/invoices/public/${number}/intent`, {
        payer,
      }),
    confirmPayment: (number: string, txHash: string) =>
      this.http.request<InvoiceRecord>("POST", `/v1/invoices/public/${number}/confirm`, {
        txHash,
      }),
  };

  escrows = {
    create: (input: CreateEscrowInput) =>
      this.http.request<EscrowIntentResponse>("POST", "/v1/escrows", input),
    list: (query: { merchantId?: string; status?: string; limit?: number; cursor?: string } = {}) =>
      this.http.requestPage<EscrowRecord>("/v1/escrows", query),
    get: (id: string) => this.http.request<EscrowRecord>("GET", `/v1/escrows/${id}`),
    intent: (
      id: string,
      action: "release" | "refund" | "dispute" | "resolve",
      resolveToPayee?: boolean,
    ) =>
      this.http.request<TransactionIntent>("POST", `/v1/escrows/${id}/${action}`, {
        resolveToPayee,
      }),
  };

  refunds = {
    request: (input: RequestRefundInput) =>
      this.http.request<RefundRecord>("POST", "/v1/refunds", input),
    list: (query: { merchantId?: string; status?: string; limit?: number; cursor?: string } = {}) =>
      this.http.requestPage<RefundRecord>("/v1/refunds", query),
    requestIntent: (id: string) =>
      this.http.request<TransactionIntent>("POST", `/v1/refunds/${id}/intent`),
    approveIntent: (id: string) =>
      this.http.request<RefundIntentResponse>("POST", `/v1/refunds/${id}/approve`),
    reject: (id: string, reason: string) =>
      this.http.request<RefundRecord>("POST", `/v1/refunds/${id}/reject`, { reason }),
  };

  subscriptions = {
    createPlan: (input: CreatePlanInput) =>
      this.http.request<SubscriptionPlanRecord>("POST", "/v1/subscriptions/plans", input),
    listPlans: (merchantId: string) =>
      this.http.requestPage<SubscriptionPlanRecord>("/v1/subscriptions/plans", { merchantId }),
    subscribe: (input: SubscribeInput) =>
      this.http.request<{ subscription: SubscriptionRecord; transaction: TransactionIntent | null }>(
        "POST",
        "/v1/subscriptions",
        input,
      ),
    list: (query: { merchantId?: string; subscriber?: string; limit?: number; cursor?: string } = {}) =>
      this.http.requestPage<SubscriptionRecord>("/v1/subscriptions", query),
    cancelIntent: (id: string) =>
      this.http.request<TransactionIntent>("POST", `/v1/subscriptions/${id}/cancel`),
  };

  settlements = {
    list: (query: { merchantId?: string; status?: string; limit?: number; cursor?: string } = {}) =>
      this.http.requestPage<{
        id: string;
        token: string;
        periodStart: string;
        periodEnd: string;
        status: string;
        total: string;
      }>("/v1/settlements", query),
  };

  webhooks = {
    create: (input: CreateWebhookInput) =>
      this.http.request<WebhookRecord>("POST", "/v1/webhooks", input),
    list: (merchantId: string) =>
      this.http.requestPage<WebhookRecord>("/v1/webhooks", { merchantId }),
    remove: (id: string) => this.http.request<void>("DELETE", `/v1/webhooks/${id}`),
    deliveries: (id: string) =>
      this.http.requestPage<WebhookDeliveryRecord>("/v1/webhooks/%s/deliveries".replace("%s", id)),
    retry: (deliveryId: string) =>
      this.http.request<WebhookDeliveryRecord>(
        "POST",
        `/v1/webhooks/deliveries/${deliveryId}/retry`,
      ),
  };

  apiKeys = {
    create: (input: CreateApiKeyInput) =>
      this.http.request<ApiKeyRecord>("POST", "/v1/api-keys", input),
    list: () => this.http.requestPage<ApiKeyRecord>("/v1/api-keys"),
    revoke: (id: string) => this.http.request<void>("DELETE", `/v1/api-keys/${id}`),
  };

  analytics = {
    overview: (merchantId: string) =>
      this.http.request<AnalyticsOverview>("GET", "/v1/analytics/overview", {
        query: { merchantId },
      }),
  };

  notifications = {
    list: (query: { merchantId?: string; unreadOnly?: boolean } = {}) =>
      this.http.requestPage<{
        id: string;
        title: string;
        body: string;
        readAt: string | null;
        createdAt: string;
      }>("/v1/notifications", query),
    markRead: (id: string) => this.http.request<void>("POST", `/v1/notifications/${id}/read`),
  };

  health = () => this.http.request<HealthStatus>("GET", "/v1/health");

  async raw<T>(method: string, path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>(method, path, body, options);
  }
}

export type { ApiErrorBody };
