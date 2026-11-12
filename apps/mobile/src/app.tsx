import { useState } from "react";
import type { InvoiceRecord } from "@wpay/types";
import { Alert, Badge, Brand, Button, Card, Field, Input, statusTone } from "@wpay/ui";
import { formatAmount } from "@wpay/hooks";
import { WPayApi } from "@wpay/sdk";

const apiUrl =
  (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_API_URL ??
  "http://localhost:4000";

const api = new WPayApi({ baseUrl: apiUrl });

export function App(): React.ReactElement {
  const [number, setNumber] = useState("");
  const [invoice, setInvoice] = useState<InvoiceRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  async function lookup(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setInvoice(null);
    try {
      const found = await api.invoices.public(number.trim().toUpperCase());
      setInvoice(found);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "lookup failed");
    } finally {
      setBusy(false);
    }
  }

  async function copyLink(): Promise<void> {
    if (!invoice) return;
    const url = `${window.location.origin}${window.location.pathname}#${invoice.number}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setError("clipboard is not available on this device");
    }
  }

  return (
    <main className="mobile-shell">
      <div className="mobile-brand">
        <Brand />
        <Badge tone="neutral">Mobile</Badge>
      </div>

      <Card title="Pay an invoice" description="Enter the invoice number from your receipt.">
        <form onSubmit={lookup} className="wp-stack">
          <Field label="Invoice number">
            <Input value={number} onChange={setNumber} placeholder="INV-…" required />
          </Field>
          <Button type="submit" loading={busy}>
            Look up
          </Button>
        </form>
      </Card>

      {error ? (
        <div style={{ marginTop: 14 }}>
          <Alert tone="error">{error}</Alert>
        </div>
      ) : null}

      {invoice ? (
        <div style={{ marginTop: 14 }}>
          <Card>
            <div className="wp-row wp-between">
              <span className="wp-mono">{invoice.number}</span>
              <Badge tone={statusTone(invoice.status)}>{invoice.status}</Badge>
            </div>
            <div className="mobile-amount">{formatAmount(invoice.amount)}</div>
            <p className="wp-muted">
              Due {new Date(invoice.dueAt).toLocaleDateString()}
              {invoice.memo ? ` · ${invoice.memo}` : ""}
            </p>
            <Button variant="secondary" onClick={() => void copyLink()}>
              {copied ? "Link copied" : "Copy payment link"}
            </Button>
            <p className="wp-muted" style={{ marginTop: 12 }}>
              Wallet signing is available in the browser checkout; this mobile view is a
              read-only companion so no payment is ever shown as completed without a network
              confirmation.
            </p>
          </Card>
        </div>
      ) : null}

      <p className="mobile-note">W-Pay · Stellar and Soroban settlement · API {apiUrl}</p>
    </main>
  );
}
