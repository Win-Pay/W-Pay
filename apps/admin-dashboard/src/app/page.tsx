"use client";

import { useCallback, useEffect, useState } from "react";
import type { HealthStatus, WPayApi } from "@wpay/sdk";
import type { TransactionIntent, UserRole } from "@wpay/types";
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
  Stat,
  Textarea,
  statusTone,
} from "@wpay/ui";
import {
  formatAmount,
  freighterAddress,
  signMessageWithFreighter,
  signWithFreighter,
  useSession,
} from "@wpay/hooks";

interface AdminMerchant {
  id: string;
  name: string;
  ownerAddress: string;
  settlementAddress: string;
  status: string;
  feeBps: number;
  registryId: string | null;
  createdAt: string;
}

interface AuditLog {
  id: string;
  actorId: string | null;
  actorAddress: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  metadata: unknown;
  ip: string | null;
  createdAt: string;
}

interface IndexerStatus {
  unresolvedFailures: number;
  checkpoints: Array<{ contractId: string; lastLedger: number; updatedAt: string }>;
  recent: Array<{
    id: string;
    contractId: string;
    txHash: string;
    ledger: number;
    kind: string;
    reason: string;
    attempts: number;
    createdAt: string;
  }>;
}

interface IndexerFailure {
  id: string;
  contractId: string;
  eventIndex: number;
  txHash: string;
  ledger: number;
  kind: string;
  reason: string;
  attempts: number;
  createdAt: string;
}

interface TreasuryOverview {
  feeRevenue: string;
  grossVolume: string;
  refundedVolume: string;
  paymentCount: number;
  vaultConfigured: boolean;
}

interface SettlementRow {
  id: string;
  token: string;
  periodStart: string;
  periodEnd: string;
  status: string;
  total: string;
}

type Tab = "merchants" | "audit" | "indexer" | "treasury" | "settlements";

interface PendingIntent {
  intent: TransactionIntent;
  description: string;
  after?: () => void | Promise<void>;
}

export default function AdminDashboard(): React.ReactElement {
  const session = useSession();
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [merchants, setMerchants] = useState<AdminMerchant[]>([]);
  const [tab, setTab] = useState<Tab>("merchants");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingIntent | null>(null);

  const load = useCallback(async () => {
    if (!session.token) return;
    try {
      const [healthStatus, merchantPage] = await Promise.all([
        session.api.health(),
        session.api.raw<{ items: AdminMerchant[] }>("GET", "/v1/admin/merchants"),
      ]);
      setHealth(healthStatus);
      setMerchants(merchantPage.items);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "failed to load admin data");
    }
  }, [session.api, session.token]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => clearInterval(timer);
  }, [load]);

  if (session.configError) {
    return (
      <main className="admin-shell">
        <Card title="Backend not configured">
          <Alert tone="error">{session.configError}</Alert>
        </Card>
      </main>
    );
  }

  if (!session.token) {
    return <Login session={session} />;
  }

  const queueIntent = (
    intent: TransactionIntent,
    description: string,
    after?: () => void | Promise<void>,
  ): void => {
    setPending({ intent, description, after });
    setNotice(`${description} transaction built. Review and sign it with the operator wallet.`);
  };

  async function setStatus(id: string, action: "approve" | "suspend"): Promise<void> {
    try {
      const result = await session.api.raw<{ transaction: TransactionIntent | null }>(
        "POST",
        `/v1/merchants/${id}/${action}`,
      );
      if (result.transaction) {
        queueIntent(result.transaction, `Merchant ${action}`, load);
      } else {
        setNotice(`Merchant ${action}d in the API. No on-chain registry is configured.`);
        await load();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "action failed");
    }
  }

  async function emergency(action: "pause" | "unpause"): Promise<void> {
    try {
      const transaction = await session.api.raw<TransactionIntent>("POST", `/v1/admin/${action}`);
      queueIntent(transaction, `Emergency ${action}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `${action} failed`);
    }
  }

  return (
    <>
      <nav className="wp-nav">
        <div className="wp-nav-inner">
          <Brand />
          <div className="wp-row">
            <Badge tone="danger">ADMIN</Badge>
            <span className="wp-muted">{session.user?.email}</span>
            <Button small variant="secondary" onClick={session.logout}>
              Sign out
            </Button>
          </div>
        </div>
      </nav>

      <main className="admin-shell">
        <PageHeader
          title="Platform administration"
          description="Merchant onboarding, incident controls and indexed state."
          actions={
            <div className="wp-row">
              <Button variant="danger" onClick={() => void emergency("pause")}>
                Pause all
              </Button>
              <Button variant="secondary" onClick={() => void emergency("unpause")}>
                Unpause
              </Button>
            </div>
          }
        />

        {error ? <Alert tone="error">{error}</Alert> : null}
        {notice ? <Alert tone="success">{notice}</Alert> : null}

        <div className="wp-grid" style={{ marginBottom: 20 }}>
          <Stat
            label="API"
            value={health?.status ?? "…"}
            hint={health ? `uptime ${health.uptimeSeconds}s` : "loading"}
          />
          <Stat label="Database" value={health?.database ?? "…"} />
          <Stat label="Soroban" value={health?.soroban ?? "…"} />
          <Stat
            label="Contracts configured"
            value={health ? Object.keys(health.contracts).length : 0}
            hint="16 total"
          />
        </div>

        {pending ? (
          <div style={{ marginBottom: 20 }}>
            <IntentSigner
              api={session.api}
              intent={pending.intent}
              description={pending.description}
              onSigned={(hash) => {
                setNotice(`${pending.description} confirmed on chain: ${hash}`);
                setPending(null);
                void pending.after?.();
              }}
              onDismiss={() => setPending(null)}
            />
          </div>
        ) : null}

        <div className="admin-tabs">
          {(["merchants", "audit", "indexer", "treasury", "settlements"] as Tab[]).map((entry) => (
            <button
              key={entry}
              className="admin-tab"
              data-active={tab === entry}
              onClick={() => setTab(entry)}
            >
              {entry[0]!.toUpperCase() + entry.slice(1)}
            </button>
          ))}
        </div>

        {tab === "merchants" ? (
          <Merchants merchants={merchants} onStatus={setStatus} />
        ) : null}
        {tab === "audit" ? <AuditLogs api={session.api} /> : null}
        {tab === "indexer" ? <IndexerPanel api={session.api} /> : null}
        {tab === "treasury" ? (
          <TreasuryPanel api={session.api} onIntent={(intent, after) => queueIntent(intent, "Treasury withdrawal", after)} />
        ) : null}
        {tab === "settlements" ? (
          <SettlementsPanel
            api={session.api}
            onIntent={(intent, description, after) => queueIntent(intent, description, after)}
          />
        ) : null}
      </main>
    </>
  );
}

function Merchants({
  merchants,
  onStatus,
}: {
  merchants: AdminMerchant[];
  onStatus: (id: string, action: "approve" | "suspend") => Promise<void>;
}): React.ReactElement {
  return (
    <Card title="Merchants">
      {merchants.length === 0 ? (
        <EmptyState title="No merchants" description="Merchants appear after registration." />
      ) : (
        <table className="wp-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Status</th>
              <th>Fee</th>
              <th>Registry id</th>
              <th>Created</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {merchants.map((merchant) => (
              <tr key={merchant.id}>
                <td>
                  <div>{merchant.name}</div>
                  <div className="wp-mono">{merchant.ownerAddress.slice(0, 10)}…</div>
                </td>
                <td>
                  <Badge tone={statusTone(merchant.status)}>{merchant.status}</Badge>
                </td>
                <td>{merchant.feeBps} bps</td>
                <td className="wp-mono">{merchant.registryId ?? "—"}</td>
                <td>{new Date(merchant.createdAt).toLocaleDateString()}</td>
                <td>
                  {merchant.status === "PENDING" || merchant.status === "SUSPENDED" ? (
                    <Button small onClick={() => void onStatus(merchant.id, "approve")}>
                      Approve
                    </Button>
                  ) : merchant.status === "ACTIVE" ? (
                    <Button
                      small
                      variant="secondary"
                      onClick={() => void onStatus(merchant.id, "suspend")}
                    >
                      Suspend
                    </Button>
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

function AuditLogs({ api }: { api: WPayApi }): React.ReactElement {
  const [items, setItems] = useState<AuditLog[]>([]);
  const [action, setAction] = useState("");
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const query = action ? `?action=${encodeURIComponent(action)}` : "";
      const page = await api.raw<{ items: AuditLog[] }>("GET", `/v1/admin/audit-logs${query}`);
      setItems(page.items);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "failed to load audit logs");
    }
  }, [api, action]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <Card
      title="Audit log"
      description="Append-only record of administrative and money-moving actions."
    >
      <div className="wp-row" style={{ marginBottom: 12 }}>
        <Input value={action} onChange={setAction} placeholder="Filter by action" />
        <Button small variant="secondary" onClick={() => void reload()}>
          Refresh
        </Button>
      </div>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {items.length === 0 ? (
        <EmptyState title="No audit entries" />
      ) : (
        <table className="wp-table">
          <thead>
            <tr>
              <th>When</th>
              <th>Action</th>
              <th>Entity</th>
              <th>Actor</th>
              <th>Metadata</th>
            </tr>
          </thead>
          <tbody>
            {items.map((entry) => (
              <tr key={entry.id}>
                <td>{new Date(entry.createdAt).toLocaleString()}</td>
                <td className="wp-mono">{entry.action}</td>
                <td>
                  {entry.entity}
                  {entry.entityId ? <div className="wp-mono">{entry.entityId.slice(0, 10)}…</div> : null}
                </td>
                <td className="wp-mono">
                  {entry.actorAddress ? `${entry.actorAddress.slice(0, 8)}…` : entry.actorId ?? "system"}
                </td>
                <td className="wp-mono" style={{ maxWidth: 320, overflowWrap: "anywhere" }}>
                  {entry.metadata ? JSON.stringify(entry.metadata) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function IndexerPanel({ api }: { api: WPayApi }): React.ReactElement {
  const [status, setStatus] = useState<IndexerStatus | null>(null);
  const [failures, setFailures] = useState<IndexerFailure[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const [nextStatus, failurePage] = await Promise.all([
        api.raw<IndexerStatus>("GET", "/v1/admin/indexer/status"),
        api.raw<{ items: IndexerFailure[] }>("GET", "/v1/admin/indexer/failures"),
      ]);
      setStatus(nextStatus);
      setFailures(failurePage.items);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "failed to load indexer status");
    }
  }, [api]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function resolve(id: string): Promise<void> {
    try {
      await api.raw("POST", `/v1/admin/indexer/failures/${id}/resolve`);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "could not resolve failure");
    }
  }

  return (
    <div className="wp-stack">
      <Card
        title="Indexer status"
        description="Contract checkpoints and unresolved event failures."
      >
        <div className="wp-row" style={{ marginBottom: 12 }}>
          <Button small variant="secondary" onClick={() => void reload()}>
            Refresh
          </Button>
        </div>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <div className="admin-grid">
          <Stat label="Unresolved failures" value={status?.unresolvedFailures ?? "…"} />
          <Stat label="Tracked contracts" value={status?.checkpoints.length ?? "…"} />
        </div>
        {status && status.checkpoints.length > 0 ? (
          <table className="wp-table" style={{ marginTop: 16 }}>
            <thead>
              <tr>
                <th>Contract</th>
                <th>Last ledger</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {status.checkpoints.map((checkpoint) => (
                <tr key={checkpoint.contractId}>
                  <td className="wp-mono">{checkpoint.contractId.slice(0, 14)}…</td>
                  <td>{checkpoint.lastLedger}</td>
                  <td>{new Date(checkpoint.updatedAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <EmptyState title="No checkpoints" description="The indexer writes one per contract after each batch." />
        )}
      </Card>

      <Card title="Unresolved events">
        {failures.length === 0 ? (
          <EmptyState title="No failures" description="All observed events were ingested." />
        ) : (
          <table className="wp-table">
            <thead>
              <tr>
                <th>Contract</th>
                <th>Ledger</th>
                <th>Kind</th>
                <th>Reason</th>
                <th>Attempts</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {failures.map((failure) => (
                <tr key={failure.id}>
                  <td className="wp-mono">{failure.contractId.slice(0, 10)}…</td>
                  <td>{failure.ledger}</td>
                  <td>{failure.kind}</td>
                  <td>{failure.reason}</td>
                  <td>{failure.attempts}</td>
                  <td>
                    <Button small variant="secondary" onClick={() => void resolve(failure.id)}>
                      Mark resolved
                    </Button>
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

function TreasuryPanel({
  api,
  onIntent,
}: {
  api: WPayApi;
  onIntent: (intent: TransactionIntent, after: () => Promise<void>) => void;
}): React.ReactElement {
  const [overview, setOverview] = useState<TreasuryOverview | null>(null);
  const [token, setToken] = useState("");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      setOverview(await api.raw<TreasuryOverview>("GET", "/v1/treasury/overview"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "failed to load treasury");
    }
  }, [api]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function withdraw(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const intent = await api.raw<TransactionIntent>("POST", "/v1/treasury/withdraw-intent", {
        token,
        to,
        amount,
      });
      onIntent(intent, reload);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "could not build withdrawal");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="wp-stack">
      <Card title="Treasury" description="Fee revenue held by the treasury vault contract.">
        {error ? <Alert tone="error">{error}</Alert> : null}
        {overview ? (
          <div className="admin-grid">
            <Stat label="Fee revenue" value={formatAmount(overview.feeRevenue)} />
            <Stat label="Gross volume" value={formatAmount(overview.grossVolume)} />
            <Stat label="Refunded" value={formatAmount(overview.refundedVolume)} />
            <Stat label="Payments" value={overview.paymentCount} />
            <Stat
              label="Vault"
              value={overview.vaultConfigured ? "configured" : "not configured"}
            />
          </div>
        ) : (
          <p className="wp-muted">Loading treasury state…</p>
        )}
      </Card>

      <Card
        title="Withdraw fees"
        description="Only ADMIN accounts with a linked Stellar wallet can build a withdrawal. The API never signs it."
      >
        <form onSubmit={withdraw} className="wp-stack">
          <Field label="Asset contract">
            <Input value={token} onChange={setToken} placeholder="C… token contract" required />
          </Field>
          <Field label="Destination">
            <Input value={to} onChange={setTo} placeholder="G… destination" required />
          </Field>
          <Field label="Amount (stroops)">
            <Input value={amount} onChange={setAmount} placeholder="1000000" required />
          </Field>
          <Button type="submit" loading={busy} disabled={!overview?.vaultConfigured}>
            Build withdrawal transaction
          </Button>
          {!overview?.vaultConfigured && overview ? (
            <Alert tone="error">CONTRACT_TREASURY_VAULT_ID is not configured on the API.</Alert>
          ) : null}
        </form>
      </Card>
    </div>
  );
}

function SettlementsPanel({
  api,
  onIntent,
}: {
  api: WPayApi;
  onIntent: (
    intent: TransactionIntent,
    description: string,
    after: () => Promise<void>,
  ) => void;
}): React.ReactElement {
  const [items, setItems] = useState<SettlementRow[]>([]);
  const [token, setToken] = useState("");
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [entries, setEntries] = useState("");
  const [linkValues, setLinkValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const page = await api.settlements.list({ limit: 50 });
      setItems(page.items);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "failed to load settlements");
    }
  }, [api]);

  useEffect(() => {
    void reload();
  }, [reload]);

  function parseEntries(): Array<{ payee: string; amount: string; merchantId?: string }> {
    return entries
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [payee, amount, merchantId] = line.split(",").map((part) => part.trim());
        if (!payee || !amount) throw new Error("each line must be payee,amount[,merchantId]");
        return { payee, amount, merchantId: merchantId || undefined };
      });
  }

  async function create(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.raw<{ window: SettlementRow; intent: TransactionIntent | null }>(
        "POST",
        "/v1/settlements/batches",
        {
          token,
          periodStart: new Date(periodStart).toISOString(),
          periodEnd: new Date(periodEnd).toISOString(),
          entries: parseEntries(),
        },
      );
      setNotice(
        result.intent
          ? "Settlement batch saved. Sign the window transaction to open it on chain."
          : "Settlement batch saved. Configure the settlement contract to open it on chain.",
      );
      if (result.intent) {
        onIntent(result.intent, "Open settlement window", reload);
      }
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "could not create settlement batch");
    } finally {
      setBusy(false);
    }
  }

  async function link(id: string): Promise<void> {
    const windowId = (linkValues[id] ?? "").trim();
    if (!/^[1-9][0-9]*$/.test(windowId)) {
      setError("window id must be a positive integer");
      return;
    }
    try {
      await api.raw("POST", `/v1/settlements/${id}/link`, { windowId });
      setNotice(`Batch linked to on-chain window ${windowId}.`);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "could not link settlement window");
    }
  }

  async function buildIntents(id: string): Promise<void> {
    try {
      const result = await api.raw<{ windowIdOnChain: string | null; intents: TransactionIntent[] }>(
        "POST",
        `/v1/settlements/${id}/intents`,
      );
      if (result.intents.length === 0) {
        setNotice(
          "No transaction was built. Configure the settlement contract and an operator wallet first.",
        );
        return;
      }
      onIntent(
        result.intents[0]!,
        result.windowIdOnChain
          ? "Add settlement entry"
          : "Open settlement window",
        reload,
      );
      if (result.intents.length > 1) {
        setNotice(
          `${result.intents.length} transactions are required for this batch. Sign them one at a time; reload after each confirmation.`,
        );
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "could not build settlement intents");
    }
  }

  async function execute(id: string): Promise<void> {
    try {
      const result = await api.raw<{ intent: TransactionIntent | null }>(
        "POST",
        `/v1/settlements/${id}/execute-intent`,
      );
      if (!result.intent) {
        setNotice("Settlement execution is not available; configure the settlement contract.");
        return;
      }
      onIntent(result.intent, "Execute settlement window", reload);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "could not build execution intent");
    }
  }

  async function cancel(id: string): Promise<void> {
    try {
      const result = await api.raw<{ intent: TransactionIntent | null }>(
        "POST",
        `/v1/settlements/${id}/cancel-intent`,
      );
      if (!result.intent) {
        setNotice("Settlement cancellation is not available; configure the settlement contract.");
        return;
      }
      onIntent(result.intent, "Cancel settlement window", reload);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "could not build cancellation intent");
    }
  }

  return (
    <div className="wp-stack">
      <Card
        title="Open settlement batch"
        description="Entries must pay each merchant's settlement address. Amounts are in stroops."
      >
        <form onSubmit={create} className="wp-stack">
          <div className="wp-grid">
            <Field label="Asset contract">
              <Input value={token} onChange={setToken} placeholder="C… token contract" required />
            </Field>
            <Field label="Period start">
              <Input value={periodStart} onChange={setPeriodStart} type="datetime-local" required />
            </Field>
            <Field label="Period end">
              <Input value={periodEnd} onChange={setPeriodEnd} type="datetime-local" required />
            </Field>
          </div>
          <Field
            label="Entries"
            hint="One per line: payee,amount[,merchantId]. The payee must equal the merchant settlement address."
          >
            <Textarea
              value={entries}
              onChange={setEntries}
              rows={4}
              placeholder={"G…,1000000,merchant_id"}
            />
          </Field>
          {error ? <Alert tone="error">{error}</Alert> : null}
          {notice ? <Alert tone="success">{notice}</Alert> : null}
          <Button type="submit" loading={busy}>
            Create batch
          </Button>
        </form>
      </Card>

      <Card title="Settlement windows">
        {items.length === 0 ? (
          <EmptyState title="No settlement windows" />
        ) : (
          <table className="wp-table">
            <thead>
              <tr>
                <th>Token</th>
                <th>Period</th>
                <th>Total</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((row) => (
                <tr key={row.id}>
                  <td className="wp-mono">{row.token.slice(0, 12)}…</td>
                  <td>
                    {new Date(row.periodStart).toLocaleDateString()} –{" "}
                    {new Date(row.periodEnd).toLocaleDateString()}
                  </td>
                  <td>{formatAmount(row.total)}</td>
                  <td>
                    <Badge tone={statusTone(row.status)}>{row.status}</Badge>
                  </td>
                  <td>
                    <div className="wp-stack" style={{ gap: 6 }}>
                      <div className="wp-row">
                        <Input
                          value={linkValues[row.id] ?? ""}
                          onChange={(value) =>
                            setLinkValues((current) => ({ ...current, [row.id]: value }))
                          }
                          placeholder="window id"
                        />
                        <Button small variant="secondary" onClick={() => void link(row.id)}>
                          Link
                        </Button>
                      </div>
                      <div className="wp-row">
                        <Button small onClick={() => void buildIntents(row.id)}>
                          Build intents
                        </Button>
                        {row.status === "CLOSED" ? (
                          <Button small onClick={() => void execute(row.id)}>
                            Execute
                          </Button>
                        ) : null}
                        {row.status !== "EXECUTED" ? (
                          <Button small variant="danger" onClick={() => void cancel(row.id)}>
                            Cancel
                          </Button>
                        ) : null}
                      </div>
                    </div>
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

function IntentSigner({
  api,
  intent,
  description,
  onSigned,
  onDismiss,
}: {
  api: WPayApi;
  intent: TransactionIntent;
  description: string;
  onSigned: (hash: string) => void;
  onDismiss: () => void;
}): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sign(): Promise<void> {
    setBusy(true);
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
      onSigned(submitted.hash);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "signing failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={description} description={`${intent.method} on ${intent.contractId}`}>
      <pre className="admin-xdr">{intent.xdr}</pre>
      <p className="wp-muted">
        The API never signs or submits admin actions on its own. Sign with the required
        admin/operator key; the result below reflects the final ledger status.
      </p>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <div className="wp-row" style={{ marginTop: 12 }}>
        <Button onClick={() => void sign()} loading={busy}>
          Sign &amp; submit
        </Button>
        <Button variant="secondary" onClick={onDismiss} disabled={busy}>
          Dismiss
        </Button>
      </div>
    </Card>
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
      if ((auth.user.role as UserRole) !== "ADMIN" && (auth.user.role as UserRole) !== "OPERATOR") {
        throw new Error("this account does not have operator access");
      }
      session.setSession(auth);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "login failed");
    } finally {
      setBusy(false);
    }
  }

  async function walletLogin(): Promise<void> {
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
      if ((auth.user.role as UserRole) !== "ADMIN" && (auth.user.role as UserRole) !== "OPERATOR") {
        throw new Error("this wallet does not have operator access");
      }
      session.setSession(auth);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "wallet sign-in failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="admin-login">
      <div style={{ marginBottom: 20 }}>
        <Brand />
      </div>
      <Card title="Operator sign in">
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
          <Button variant="secondary" onClick={() => void walletLogin()} disabled={busy}>
            Sign in with admin wallet
          </Button>
        </form>
      </Card>
    </div>
  );
}
