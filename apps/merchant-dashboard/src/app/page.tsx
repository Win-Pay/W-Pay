"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AnalyticsOverview,
  ApiKeyRecord,
  WPayApi,
  WebhookRecord,
} from "@wpay/sdk";
import type {
  InvoiceRecord,
  MerchantRecord,
  PaymentRecord,
  RefundRecord,
  SubscriptionPlanRecord,
  SubscriptionRecord,
  TransactionIntent,
  WebhookEvent,
} from "@wpay/types";
import {
  Alert,
  Badge,
  Brand,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Select,
  Stat,
  statusTone,
} from "@wpay/ui";
import {
  formatAmount,
  freighterAddress,
  signMessageWithFreighter,
  signWithFreighter,
  useSession,
  type SessionUser,
} from "@wpay/hooks";

type Tab =
  | "overview"
  | "payments"
  | "invoices"
  | "refunds"
  | "settlements"
  | "subscriptions"
  | "developers";

export default function MerchantDashboard(): React.ReactElement {
  const session = useSession();
  const [merchants, setMerchants] = useState<MerchantRecord[]>([]);
  const [merchantId, setMerchantId] = useState<string>("");
  const [tab, setTab] = useState<Tab>("overview");
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const merchant = useMemo(
    () => merchants.find((entry) => entry.id === merchantId) ?? null,
    [merchants, merchantId],
  );

  const loadMerchants = useCallback(async () => {
    if (!session.token) return;
    setError(null);
    try {
      const user = await session.api.auth.me();
      session.setUser(user as SessionUser);
      const page = await session.api.merchants.list({ limit: 100 });
      setMerchants(page.items);
      setMerchantId((current) => current || page.items[0]?.id || "");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "failed to load merchants");
    } finally {
      setLoaded(true);
    }
  }, [session.api, session.token]);

  useEffect(() => {
    void loadMerchants();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.token]);

  if (session.configError) {
    return (
      <main className="dash-shell">
        <Card title="Backend not configured">
          <Alert tone="error">{session.configError}</Alert>
        </Card>
      </main>
    );
  }

  if (!session.token) {
    return <Login session={session} />;
  }

  return (
    <>
      <nav className="wp-nav">
        <div className="wp-nav-inner">
          <Brand />
          <div className="wp-row">
            <span className="wp-muted">{session.user?.email ?? "merchant"}</span>
            <Button variant="secondary" small onClick={session.logout}>
              Sign out
            </Button>
          </div>
        </div>
      </nav>

      <main className="dash-shell">
        <PageHeader
          title="Merchant operations"
          description="Live payments, settlements, and developer integrations from the W-Pay API."
          actions={
            merchants.length > 1 ? (
              <Select
                value={merchantId}
                onChange={setMerchantId}
                options={merchants.map((entry) => ({ value: entry.id, label: entry.name }))}
              />
            ) : undefined
          }
        />

        {error ? <Alert tone="error">{error}</Alert> : null}

        {!loaded ? (
          <Card title="Loading merchant account…">Contacting the W-Pay API.</Card>
        ) : merchant ? (
          <>
            <div className="wp-row" style={{ margin: "8px 0 20px" }}>
              <Badge tone={statusTone(merchant.status)}>{merchant.status}</Badge>
              <span className="wp-mono">{merchant.settlementAddress}</span>
              <Badge tone="neutral">{merchant.feeBps} bps fee</Badge>
              <Badge tone="neutral">
                {merchant.registryId ? `registry #${merchant.registryId}` : "not on chain"}
              </Badge>
            </div>

            <div className="dash-tabs">
              {(
                [
                  "overview",
                  "payments",
                  "invoices",
                  "refunds",
                  "settlements",
                  "subscriptions",
                  "developers",
                ] as Tab[]
              ).map((entry) => (
                <button
                  key={entry}
                  className="dash-tab"
                  data-active={tab === entry}
                  onClick={() => setTab(entry)}
                >
                  {entry[0]!.toUpperCase() + entry.slice(1)}
                </button>
              ))}
            </div>

            {tab === "overview" ? (
              <Overview api={session.api} merchantId={merchant.id} />
            ) : null}
            {tab === "payments" ? (
              <Payments api={session.api} merchantId={merchant.id} />
            ) : null}
            {tab === "invoices" ? (
              <Invoices api={session.api} merchant={merchant} />
            ) : null}
            {tab === "refunds" ? (
              <Refunds api={session.api} merchantId={merchant.id} />
            ) : null}
            {tab === "settlements" ? (
              <Settlements api={session.api} merchantId={merchant.id} />
            ) : null}
            {tab === "subscriptions" ? (
              <Subscriptions api={session.api} merchant={merchant} />
            ) : null}
            {tab === "developers" ? (
              <Developers api={session.api} merchantId={merchant.id} />
            ) : null}
          </>
        ) : (
          <Onboarding session={session} onCreated={loadMerchants} />
        )}
      </main>
    </>
  );
}

function Login({ session }: { session: ReturnType<typeof useSession> }): React.ReactElement {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const auth = await session.api.auth.login({ email, password });
      session.setSession(auth);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dash-login">
      <div style={{ marginBottom: 20 }}>
        <Brand />
      </div>
      <Card title="Merchant sign in" description="Use your email account or onboard a wallet below.">
        <form onSubmit={submit} className="wp-stack">
          <Field label="Email">
            <Input value={email} onChange={setEmail} type="email" required />
          </Field>
          <Field label="Password">
            <Input value={password} onChange={setPassword} type="password" required />
          </Field>
          {error ? <Alert tone="error">{error}</Alert> : null}
          <Button type="submit" loading={busy}>
            Sign in
          </Button>
        </form>
        <div style={{ marginTop: 20 }}>
          <WalletSignIn session={session} label="Sign in with a Stellar wallet instead" />
        </div>
      </Card>
    </div>
  );
}

function WalletSignIn({
  session,
  label,
}: {
  session: ReturnType<typeof useSession>;
  label: string;
}): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const address = await freighterAddress();
      const challenge = await session.api.auth.walletChallenge(address);
      const signature = await signMessageWithFreighter(challenge.message, address);
      const auth = await session.api.auth.walletVerify({
        address,
        nonce: challenge.nonce,
        signature,
      });
      session.setSession(auth);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "wallet sign-in failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="wp-stack">
      {error ? <Alert tone="error">{error}</Alert> : null}
      <Button variant="secondary" onClick={() => void signIn()} loading={busy}>
        {label}
      </Button>
    </div>
  );
}

function Onboarding({
  session,
  onCreated,
}: {
  session: ReturnType<typeof useSession>;
  onCreated: () => Promise<void>;
}): React.ReactElement {
  const [name, setName] = useState("");
  const [settlement, setSettlement] = useState("");
  const [website, setWebsite] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function create(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const address = await freighterAddress();
      const challenge = await session.api.auth.walletChallenge(address);
      const signature = await signMessageWithFreighter(challenge.message, address);
      const auth = await session.api.auth.walletVerify({
        address,
        nonce: challenge.nonce,
        signature,
      });
      session.setSession(auth);
      const merchant = await session.api.merchants.create({
        name,
        ownerAddress: address,
        settlementAddress: settlement.trim() || address,
        feeBps: 250,
        website: website.trim() || undefined,
      });
      setNotice(
        `Merchant ${merchant.name} registered with status ${merchant.status}. An operator must approve it before payments can settle.`,
      );
      await onCreated();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "could not register merchant");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="wp-stack">
      <Card
        title="Register a merchant"
        description="The wallet you sign with becomes the merchant owner. Registration is pending until a platform operator approves it."
      >
        <form onSubmit={create} className="wp-stack">
          <Field label="Business name">
            <Input value={name} onChange={setName} placeholder="Acme Store" required />
          </Field>
          <Field
            label="Settlement address"
            hint="Leave blank to settle to the same wallet you sign in with."
          >
            <Input
              value={settlement}
              onChange={setSettlement}
              placeholder="G… (optional)"
            />
          </Field>
          <Field label="Website" hint="Optional">
            <Input value={website} onChange={setWebsite} placeholder="https://example.com" />
          </Field>
          {error ? <Alert tone="error">{error}</Alert> : null}
          {notice ? <Alert tone="success">{notice}</Alert> : null}
          <Button type="submit" loading={busy}>
            Connect wallet and register
          </Button>
        </form>
      </Card>
      <Card title="Already registered?" description="Sign in with the wallet that owns the merchant.">
        <WalletSignIn session={session} label="Sign in with merchant wallet" />
      </Card>
    </div>
  );
}

function Overview({ api, merchantId }: { api: WPayApi; merchantId: string }): React.ReactElement {
  const [data, setData] = useState<AnalyticsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.analytics
      .overview(merchantId)
      .then(setData)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "failed"));
  }, [api, merchantId]);

  if (error) return <Alert tone="error">{error}</Alert>;
  if (!data) return <Card title="Loading analytics…">Fetching the last 30 days.</Card>;

  return (
    <div className="wp-stack">
      <div className="dash-grid">
        <Stat label="Gross volume (30d)" value={formatAmount(data.grossVolume)} />
        <Stat label="Fees paid" value={formatAmount(data.feesPaid)} />
        <Stat label="Refunded" value={formatAmount(data.refundedVolume)} />
        <Stat label="Payments" value={data.paymentCount} hint={`${data.settledCount} settled`} />
        <Stat label="Average payment" value={formatAmount(data.averagePayment)} />
        <Stat label="Pending refunds" value={data.pendingRefunds} />
      </div>
      <Card title="Daily volume" description="Settled payments in the last 30 days.">
        {data.daily.length === 0 ? (
          <EmptyState title="No settled payments yet" />
        ) : (
          <table className="wp-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Volume</th>
                <th>Payments</th>
              </tr>
            </thead>
            <tbody>
              {data.daily.map((entry) => (
                <tr key={entry.date}>
                  <td>{entry.date}</td>
                  <td>{formatAmount(entry.volume)}</td>
                  <td>{entry.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

function Payments({
  api,
  merchantId,
}: {
  api: WPayApi;
  merchantId: string;
}): React.ReactElement {
  const [items, setItems] = useState<PaymentRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.payments
      .list({ merchantId, limit: 50 })
      .then((page) => setItems(page.items))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "failed"));
  }, [api, merchantId]);

  if (error) return <Alert tone="error">{error}</Alert>;
  return (
    <Card title="Payments">
      {items.length === 0 ? (
        <EmptyState title="No payments yet" description="Payments appear here as soon as they are created." />
      ) : (
        <table className="wp-table">
          <thead>
            <tr>
              <th>Created</th>
              <th>Amount</th>
              <th>Fee</th>
              <th>Refunded</th>
              <th>Status</th>
              <th>Payer</th>
            </tr>
          </thead>
          <tbody>
            {items.map((payment) => (
              <tr key={payment.id}>
                <td>{new Date(payment.createdAt).toLocaleString()}</td>
                <td>{formatAmount(payment.amount)}</td>
                <td>{formatAmount(payment.fee)}</td>
                <td>{formatAmount(payment.refunded)}</td>
                <td>
                  <Badge tone={statusTone(payment.status)}>{payment.status}</Badge>
                </td>
                <td className="wp-mono">{payment.payerAddress.slice(0, 8)}…</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function Invoices({
  api,
  merchant,
}: {
  api: WPayApi;
  merchant: MerchantRecord;
}): React.ReactElement {
  const [items, setItems] = useState<InvoiceRecord[]>([]);
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [token, setToken] = useState("");
  const [days, setDays] = useState("7");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<InvoiceRecord | null>(null);

  const reload = useCallback(
    () =>
      api.invoices
        .list({ merchantId: merchant.id, limit: 50 })
        .then((page) => setItems(page.items))
        .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "failed")),
    [api, merchant.id],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  async function create(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const invoice = await api.invoices.create({
        merchantId: merchant.id,
        token,
        amount,
        memo: memo || undefined,
        dueAt: new Date(Date.now() + Number(days) * 86_400_000),
      });
      setCreated(invoice);
      setAmount("");
      setMemo("");
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "could not create invoice");
    } finally {
      setBusy(false);
    }
  }

  async function cancel(id: string): Promise<void> {
    try {
      await api.invoices.cancel(id);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "could not cancel invoice");
    }
  }

  const checkoutUrl =
    created && typeof window !== "undefined"
      ? `${window.location.origin.replace(/merchant[^.]*/, "wpay-web")}/?invoice=${created.number}`
      : null;

  return (
    <div className="wp-stack">
      <Card title="Create invoice">
        <form onSubmit={create} className="wp-stack">
          <div className="wp-grid">
            <Field label="Amount (stroops)">
              <Input value={amount} onChange={setAmount} placeholder="10000000" required />
            </Field>
            <Field label="Asset contract">
              <Input
                value={token}
                onChange={setToken}
                placeholder="C… token contract id"
                required
              />
            </Field>
            <Field label="Due in (days)">
              <Input value={days} onChange={setDays} type="number" min="1" max="365" />
            </Field>
          </div>
          <Field label="Memo">
            <Input value={memo} onChange={setMemo} placeholder="PO number or description" />
          </Field>
          {error ? <Alert tone="error">{error}</Alert> : null}
          {created ? (
            <Alert tone="success">
              Invoice {created.number} created.{" "}
              {checkoutUrl ? <a href={checkoutUrl}>Open checkout</a> : null}
            </Alert>
          ) : null}
          <Button type="submit" loading={busy}>
            Create invoice
          </Button>
        </form>
      </Card>

      <Card title="Invoices">
        {items.length === 0 ? (
          <EmptyState title="No invoices yet" />
        ) : (
          <table className="wp-table">
            <thead>
              <tr>
                <th>Number</th>
                <th>Amount</th>
                <th>Due</th>
                <th>Status</th>
                <th>Transaction</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((invoice) => (
                <tr key={invoice.id}>
                  <td className="wp-mono">{invoice.number}</td>
                  <td>{formatAmount(invoice.amount)}</td>
                  <td>{new Date(invoice.dueAt).toLocaleDateString()}</td>
                  <td>
                    <Badge tone={statusTone(invoice.status)}>{invoice.status}</Badge>
                  </td>
                  <td className="wp-mono">
                    {invoice.txHash ? `${invoice.txHash.slice(0, 10)}…` : "—"}
                  </td>
                  <td>
                    {invoice.status === "OPEN" ? (
                      <Button small variant="secondary" onClick={() => void cancel(invoice.id)}>
                        Cancel
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

function Refunds({
  api,
  merchantId,
}: {
  api: WPayApi;
  merchantId: string;
}): React.ReactElement {
  const [items, setItems] = useState<RefundRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [wallet, setWallet] = useState<string | null>(null);
  const [approval, setApproval] = useState<{ xdr: string; networkPassphrase: string } | null>(
    null,
  );
  const [signing, setSigning] = useState(false);

  const reload = useCallback(
    () =>
      api.refunds
        .list({ merchantId, limit: 50 })
        .then((page) => setItems(page.items))
        .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "failed")),
    [api, merchantId],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  async function signApproval(next: { xdr: string; networkPassphrase: string }): Promise<void> {
    setSigning(true);
    setError(null);
    try {
      const address = wallet ?? (await freighterAddress());
      setWallet(address);
      const signedXdr = await signWithFreighter(next.xdr, next.networkPassphrase, address);
      const submitted = await api.raw<{ hash: string; status: string }>(
        "POST",
        "/v1/transactions/submit",
        { xdr: signedXdr },
      );
      if (submitted.status !== "SUCCESS") {
        throw new Error(`transaction ${submitted.status.toLowerCase()} (${submitted.hash})`);
      }
      setNotice(`Refund approval confirmed on chain: ${submitted.hash}`);
      setApproval(null);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "could not sign the approval");
    } finally {
      setSigning(false);
    }
  }

  async function approve(id: string): Promise<void> {
    try {
      const response = await api.refunds.approveIntent(id);
      await reload();
      if (!response.transaction) {
        setNotice(
          "Approval recorded. The on-chain refund id is not indexed yet, so no transaction can be signed.",
        );
        return;
      }
      const next = {
        xdr: response.transaction.xdr,
        networkPassphrase: response.transaction.networkPassphrase,
      };
      setApproval(next);
      if (wallet) {
        await signApproval(next);
      } else {
        setNotice(
          "Approval recorded. Connect the settlement wallet, then sign the approval transaction.",
        );
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "could not approve refund");
    }
  }

  async function reject(id: string): Promise<void> {
    try {
      await api.refunds.reject(id, "declined by merchant");
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "could not reject refund");
    }
  }

  async function connect(): Promise<void> {
    try {
      setWallet(await freighterAddress());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "could not connect wallet");
    }
  }

  return (
    <Card title="Refund requests">
      {error ? <Alert tone="error">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      <div className="wp-row" style={{ marginBottom: 12 }}>
        {wallet ? (
          <span className="wp-mono">
            Settlement wallet {wallet.slice(0, 8)}…{wallet.slice(-6)}
          </span>
        ) : (
          <Button small variant="secondary" onClick={() => void connect()}>
            Connect settlement wallet
          </Button>
        )}
        {approval ? (
          <Button small loading={signing} onClick={() => void signApproval(approval)}>
            Sign approval transaction
          </Button>
        ) : null}
      </div>
      {items.length === 0 ? (
        <EmptyState title="No refund requests" />
      ) : (
        <table className="wp-table">
          <thead>
            <tr>
              <th>Amount</th>
              <th>Reason</th>
              <th>Status</th>
              <th>Requested</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((refund) => (
              <tr key={refund.id}>
                <td>{formatAmount(refund.amount)}</td>
                <td>{refund.reason}</td>
                <td>
                  <Badge tone={statusTone(refund.status)}>{refund.status}</Badge>
                </td>
                <td>{new Date(refund.createdAt).toLocaleDateString()}</td>
                <td className="wp-row">
                  {refund.status === "PENDING" ? (
                    <>
                      <Button small onClick={() => void approve(refund.id)}>
                        Approve
                      </Button>
                      <Button small variant="secondary" onClick={() => void reject(refund.id)}>
                        Reject
                      </Button>
                    </>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function Settlements({
  api,
  merchantId,
}: {
  api: WPayApi;
  merchantId: string;
}): React.ReactElement {
  const [items, setItems] = useState<
    Array<{
      id: string;
      token: string;
      periodStart: string;
      periodEnd: string;
      status: string;
      total: string;
    }>
  >([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.settlements
      .list({ merchantId, limit: 50 })
      .then((page) => setItems(page.items))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "failed"));
  }, [api, merchantId]);

  return (
    <Card
      title="Settlement batches"
      description="On-chain settlement windows that include this merchant. Operators open, close and execute them."
    >
      {error ? <Alert tone="error">{error}</Alert> : null}
      {items.length === 0 ? (
        <EmptyState
          title="No settlement batches"
          description="Batches created by the platform operator appear here."
        />
      ) : (
        <table className="wp-table">
          <thead>
            <tr>
              <th>Token</th>
              <th>Period</th>
              <th>Total</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {items.map((entry) => (
              <tr key={entry.id}>
                <td className="wp-mono">{entry.token.slice(0, 12)}…</td>
                <td>
                  {new Date(entry.periodStart).toLocaleDateString()} –{" "}
                  {new Date(entry.periodEnd).toLocaleDateString()}
                </td>
                <td>{formatAmount(entry.total)}</td>
                <td>
                  <Badge tone={statusTone(entry.status)}>{entry.status}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function Subscriptions({
  api,
  merchant,
}: {
  api: WPayApi;
  merchant: MerchantRecord;
}): React.ReactElement {
  const [plans, setPlans] = useState<SubscriptionPlanRecord[]>([]);
  const [subscriptions, setSubscriptions] = useState<SubscriptionRecord[]>([]);
  const [token, setToken] = useState("");
  const [amount, setAmount] = useState("");
  const [intervalSecs, setIntervalSecs] = useState("2592000");
  const [busy, setBusy] = useState(false);
  const [signing, setSigning] = useState(false);
  const [intent, setIntent] = useState<TransactionIntent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [planPage, subPage] = await Promise.all([
        api.subscriptions.listPlans(merchant.id),
        api.subscriptions.list({ merchantId: merchant.id, limit: 50 }),
      ]);
      setPlans(planPage.items);
      setSubscriptions(subPage.items);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "failed to load subscriptions");
    }
  }, [api, merchant.id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function createPlan(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const plan = await api.subscriptions.createPlan({
        merchantId: merchant.id,
        token,
        amount,
        intervalSecs: Number(intervalSecs),
      });
      setIntent(plan.transaction);
      setNotice(
        plan.transaction
          ? "Plan saved. Sign the transaction to create it on chain; the indexer will link the on-chain plan id."
          : "Plan saved. Configure CONTRACT_SUBSCRIPTION_MANAGER_ID and a merchant registry id to create it on chain.",
      );
      setAmount("");
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "could not create plan");
    } finally {
      setBusy(false);
    }
  }

  async function signPlan(): Promise<void> {
    if (!intent) return;
    setSigning(true);
    setError(null);
    try {
      const address = await freighterAddress();
      const signedXdr = await signWithFreighter(intent.xdr, intent.networkPassphrase, address);
      const submitted = await api.raw<{ hash: string; status: string }>(
        "POST",
        "/v1/transactions/submit",
        { xdr: signedXdr },
      );
      if (submitted.status !== "SUCCESS") {
        throw new Error(`transaction ${submitted.status.toLowerCase()} (${submitted.hash})`);
      }
      setNotice(`Plan created on chain: ${submitted.hash}`);
      setIntent(null);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "could not sign plan transaction");
    } finally {
      setSigning(false);
    }
  }

  return (
    <div className="wp-stack">
      <Card title="Create subscription plan">
        <form onSubmit={createPlan} className="wp-stack">
          <div className="wp-grid">
            <Field label="Asset contract">
              <Input value={token} onChange={setToken} placeholder="C… token contract" required />
            </Field>
            <Field label="Amount per cycle (stroops)">
              <Input value={amount} onChange={setAmount} placeholder="5000000" required />
            </Field>
            <Field label="Interval (seconds)">
              <Input
                value={intervalSecs}
                onChange={setIntervalSecs}
                type="number"
                min="60"
                required
              />
            </Field>
          </div>
          {error ? <Alert tone="error">{error}</Alert> : null}
          {notice ? <Alert tone="success">{notice}</Alert> : null}
          <div className="wp-row">
            <Button type="submit" loading={busy}>
              Save plan
            </Button>
            {intent ? (
              <Button variant="secondary" loading={signing} onClick={() => void signPlan()}>
                Sign plan transaction
              </Button>
            ) : null}
          </div>
        </form>
      </Card>

      <Card title="Plans">
        {plans.length === 0 ? (
          <EmptyState title="No plans yet" />
        ) : (
          <table className="wp-table">
            <thead>
              <tr>
                <th>Amount</th>
                <th>Interval</th>
                <th>On-chain id</th>
                <th>Active</th>
              </tr>
            </thead>
            <tbody>
              {plans.map((plan) => (
                <tr key={plan.id}>
                  <td>{formatAmount(plan.amount)}</td>
                  <td>{Math.round(plan.intervalSecs / 86_400)} days</td>
                  <td className="wp-mono">{plan.planIdOnChain ?? "pending indexer"}</td>
                  <td>
                    <Badge tone={plan.active ? "success" : "danger"}>
                      {plan.active ? "ACTIVE" : "INACTIVE"}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="Subscriptions">
        {subscriptions.length === 0 ? (
          <EmptyState title="No subscribers yet" />
        ) : (
          <table className="wp-table">
            <thead>
              <tr>
                <th>Subscriber</th>
                <th>Prepaid</th>
                <th>Next due</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {subscriptions.map((subscription) => (
                <tr key={subscription.id}>
                  <td className="wp-mono">{subscription.subscriber.slice(0, 10)}…</td>
                  <td>{formatAmount(subscription.prepaid)}</td>
                  <td>{new Date(subscription.nextDueAt).toLocaleDateString()}</td>
                  <td>
                    <Badge tone={statusTone(subscription.status)}>{subscription.status}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

function Developers({
  api,
  merchantId,
}: {
  api: WPayApi;
  merchantId: string;
}): React.ReactElement {
  const [endpoints, setEndpoints] = useState<WebhookRecord[]>([]);
  const [keys, setKeys] = useState<ApiKeyRecord[]>([]);
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState(
    "payment.settled,invoice.paid,refund.requested,refund.approved",
  );
  const [keyName, setKeyName] = useState("server key");
  const [secret, setSecret] = useState<string | null>(null);
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [endpointPage, keyPage] = await Promise.all([
        api.webhooks.list(merchantId),
        api.apiKeys.list(),
      ]);
      setEndpoints(endpointPage.items);
      setKeys(keyPage.items.filter((entry) => entry.merchantId === merchantId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "failed to load developer settings");
    }
  }, [api, merchantId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function createEndpoint(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setNotice(null);
    try {
      const parsed = events
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean) as WebhookEvent[];
      const endpoint = await api.webhooks.create({ merchantId, url, events: parsed });
      setSecret(endpoint.secret ?? null);
      setUrl("");
      setNotice("Webhook registered. Copy the signing secret now; it is shown once.");
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "could not create webhook");
    }
  }

  async function removeEndpoint(id: string): Promise<void> {
    try {
      await api.webhooks.remove(id);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "could not remove webhook");
    }
  }

  async function createKey(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setNotice(null);
    try {
      const created = await api.apiKeys.create({ name: keyName, merchantId });
      setCreatedKey(created.key ?? null);
      setNotice("API key created. Copy it now; it is shown once.");
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "could not create API key");
    }
  }

  async function revokeKey(id: string): Promise<void> {
    try {
      await api.apiKeys.revoke(id);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "could not revoke API key");
    }
  }

  return (
    <div className="wp-stack">
      <Card
        title="Webhooks"
        description="Signed with HMAC-SHA256 in the x-wpay-signature header. Failed deliveries retry with backoff."
      >
        <form onSubmit={createEndpoint} className="wp-stack">
          <Field label="Endpoint URL" hint="HTTPS is required in production.">
            <Input value={url} onChange={setUrl} placeholder="https://example.com/wpay" required />
          </Field>
          <Field label="Events" hint="Comma-separated event names.">
            <Input value={events} onChange={setEvents} required />
          </Field>
          {error ? <Alert tone="error">{error}</Alert> : null}
          {notice ? <Alert tone="success">{notice}</Alert> : null}
          {secret ? (
            <Alert tone="success">
              Signing secret: <span className="wp-mono">{secret}</span>
            </Alert>
          ) : null}
          <Button type="submit">Register webhook</Button>
        </form>
        <div style={{ marginTop: 20 }}>
          {endpoints.length === 0 ? (
            <EmptyState title="No webhook endpoints" />
          ) : (
            <table className="wp-table">
              <thead>
                <tr>
                  <th>URL</th>
                  <th>Events</th>
                  <th>Active</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {endpoints.map((endpoint) => (
                  <tr key={endpoint.id}>
                    <td className="wp-mono">{endpoint.url}</td>
                    <td>{endpoint.events.join(", ")}</td>
                    <td>
                      <Badge tone={endpoint.active ? "success" : "danger"}>
                        {endpoint.active ? "ACTIVE" : "DISABLED"}
                      </Badge>
                    </td>
                    <td>
                      <Button
                        small
                        variant="secondary"
                        onClick={() => void removeEndpoint(endpoint.id)}
                      >
                        Delete
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Card>

      <Card
        title="API keys"
        description="Use x-api-key for server-to-server calls. A merchant-scoped key cannot read other merchants."
      >
        <form onSubmit={createKey} className="wp-stack">
          <Field label="Key name">
            <Input value={keyName} onChange={setKeyName} required />
          </Field>
          {createdKey ? (
            <Alert tone="success">
              API key: <span className="wp-mono">{createdKey}</span>
            </Alert>
          ) : null}
          <Button type="submit">Create key</Button>
        </form>
        <div style={{ marginTop: 20 }}>
          {keys.length === 0 ? (
            <EmptyState title="No active API keys" />
          ) : (
            <table className="wp-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Prefix</th>
                  <th>Last used</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {keys.map((key) => (
                  <tr key={key.id}>
                    <td>{key.name}</td>
                    <td className="wp-mono">{key.prefix}…</td>
                    <td>{key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString() : "never"}</td>
                    <td>
                      <Button small variant="secondary" onClick={() => void revokeKey(key.id)}>
                        Revoke
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Card>
    </div>
  );
}
