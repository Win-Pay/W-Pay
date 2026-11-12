"use client";

import { useCallback, useEffect, useState } from "react";
import type { HealthStatus } from "@wpay/sdk";
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
  statusTone,
} from "@wpay/ui";
import { useSession, type SessionUser } from "@wpay/hooks";

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

export default function AdminDashboard(): React.ReactElement {
  const session = useSession();
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [merchants, setMerchants] = useState<AdminMerchant[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [intent, setIntent] = useState<TransactionIntent | null>(null);

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

  if (!session.token) {
    return <Login session={session} />;
  }

  async function setStatus(id: string, action: "approve" | "suspend"): Promise<void> {
    try {
      const result = await session.api.raw<{ transaction: TransactionIntent | null }>(
        "POST",
        `/v1/merchants/${id}/${action}`,
      );
      setNotice(
        result.transaction
          ? `Merchant ${action}d in the API. An on-chain transaction is ready to sign below.`
          : `Merchant ${action}d in the API. No on-chain registry is configured.`,
      );
      setIntent(result.transaction);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "action failed");
    }
  }

  async function emergency(action: "pause" | "unpause"): Promise<void> {
    try {
      const transaction = await session.api.raw<TransactionIntent>("POST", `/v1/admin/${action}`);
      setIntent(transaction);
      setNotice(`Emergency ${action} transaction built. Sign it with an admin wallet to apply.`);
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

        {intent ? (
          <Card
            title="Transaction ready to sign"
            description={`${intent.method} on ${intent.contractId}`}
          >
            <pre className="admin-xdr">{intent.xdr}</pre>
            <p className="wp-muted">
              Open this XDR in a Stellar wallet or signer with the required admin/operator key.
              The API never signs or submits admin actions on its own.
            </p>
          </Card>
        ) : null}

        <div style={{ marginTop: 20 }}>
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
                          <Button small onClick={() => void setStatus(merchant.id, "approve")}>
                            Approve
                          </Button>
                        ) : merchant.status === "ACTIVE" ? (
                          <Button
                            small
                            variant="secondary"
                            onClick={() => void setStatus(merchant.id, "suspend")}
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
        </div>
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
      if ((auth.user.role as UserRole) !== "ADMIN" && (auth.user.role as UserRole) !== "OPERATOR") {
        throw new Error("this account does not have operator access");
      }
      session.setToken(auth.accessToken);
      session.setUser(auth.user as SessionUser);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "login failed");
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
        </form>
      </Card>
    </div>
  );
}
