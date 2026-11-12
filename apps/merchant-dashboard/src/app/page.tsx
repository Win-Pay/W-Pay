"use client";

import { useEffect, useMemo, useState } from "react";
import type { AnalyticsOverview } from "@wpay/sdk";
import type { InvoiceRecord, MerchantRecord, PaymentRecord, RefundRecord } from "@wpay/types";
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
import { formatAmount, useSession, type SessionUser } from "@wpay/hooks";

type Tab = "overview" | "payments" | "invoices" | "refunds";

export default function MerchantDashboard(): React.ReactElement {
  const session = useSession();
  const [merchants, setMerchants] = useState<MerchantRecord[]>([]);
  const [merchantId, setMerchantId] = useState<string>("");
  const [tab, setTab] = useState<Tab>("overview");
  const [error, setError] = useState<string | null>(null);

  const merchant = useMemo(
    () => merchants.find((entry) => entry.id === merchantId) ?? null,
    [merchants, merchantId],
  );

  useEffect(() => {
    if (!session.token) return;
    session.api.auth
      .me()
      .then((user) => {
        session.setUser(user as SessionUser);
        return session.api.merchants.list({ limit: 100 });
      })
      .then((page) => {
        setMerchants(page.items);
        if (page.items[0]) setMerchantId(page.items[0].id);
      })
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "failed to load merchants"),
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.token]);

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
          description="Live payments, invoices and refunds from the W-Pay API."
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

        {merchant ? (
          <div className="wp-row" style={{ margin: "8px 0 20px" }}>
            <Badge tone={statusTone(merchant.status)}>{merchant.status}</Badge>
            <span className="wp-mono">{merchant.settlementAddress}</span>
            <Badge tone="neutral">{merchant.feeBps} bps fee</Badge>
          </div>
        ) : (
          <EmptyState
            title="No merchant account yet"
            description="Create a merchant through the API or the admin dashboard to start accepting payments."
          />
        )}

        <div className="dash-tabs">
          {(["overview", "payments", "invoices", "refunds"] as Tab[]).map((entry) => (
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

        {merchant && tab === "overview" ? <Overview merchantId={merchant.id} /> : null}
        {merchant && tab === "payments" ? <Payments merchantId={merchant.id} /> : null}
        {merchant && tab === "invoices" ? <Invoices merchant={merchant} /> : null}
        {merchant && tab === "refunds" ? <Refunds merchantId={merchant.id} /> : null}
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
      session.setToken(auth.accessToken);
      session.setUser(auth.user as SessionUser);
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
      <Card title="Merchant sign in" description="Use the account created by the platform operator.">
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
      </Card>
    </div>
  );
}

function Overview({ merchantId }: { merchantId: string }): React.ReactElement {
  const { api } = useSession();
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

function Payments({ merchantId }: { merchantId: string }): React.ReactElement {
  const { api } = useSession();
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

function Invoices({ merchant }: { merchant: MerchantRecord }): React.ReactElement {
  const { api } = useSession();
  const [items, setItems] = useState<InvoiceRecord[]>([]);
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [token, setToken] = useState("");
  const [days, setDays] = useState("7");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<InvoiceRecord | null>(null);

  const reload = () =>
    api.invoices
      .list({ merchantId: merchant.id, limit: 50 })
      .then((page) => setItems(page.items))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "failed"));

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [merchant.id]);

  async function create(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const invoice = await api.invoices.create({
        merchantId: merchant.id,
        token: token || merchant.settlementAddress,
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

  return (
    <div className="wp-stack">
      <Card title="Create invoice">
        <form onSubmit={create} className="wp-stack">
          <div className="wp-grid">
            <Field label="Amount (stroops)">
              <Input value={amount} onChange={setAmount} placeholder="10000000" required />
            </Field>
            <Field label="Asset contract (optional)">
              <Input value={token} onChange={setToken} placeholder="Defaults to settlement address" />
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
              Invoice {created.number} created — share it on the checkout app.
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

function Refunds({ merchantId }: { merchantId: string }): React.ReactElement {
  const { api } = useSession();
  const [items, setItems] = useState<RefundRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = () =>
    api.refunds
      .list({ merchantId, limit: 50 })
      .then((page) => setItems(page.items))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "failed"));

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [merchantId]);

  async function approve(id: string): Promise<void> {
    try {
      const response = await api.refunds.approveIntent(id);
      setNotice(
        response.transaction
          ? "Approval recorded. Sign the transaction with the settlement wallet to move funds."
          : "Approval recorded. The on-chain refund id is not indexed yet, so no transaction can be signed.",
      );
      await reload();
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

  return (
    <Card title="Refund requests">
      {error ? <Alert tone="error">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}
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
