"use client";

import { useEffect, useState } from "react";
import type { InvoiceRecord } from "@wpay/types";
import { Alert, Badge, Brand, Button, Card, Field, Input, statusTone } from "@wpay/ui";
import { useSession, formatAmount } from "@wpay/hooks";

interface FreighterLike {
  getPublicKey?: () => Promise<string>;
  getAddress?: () => Promise<{ address: string } | string>;
  signTransaction: (
    xdr: string,
    options: { networkPassphrase: string },
  ) => Promise<{ signedTxXdr: string }>;
}

function freighter(): FreighterLike | null {
  if (typeof window === "undefined") return null;
  const candidate = (window as unknown as Record<string, unknown>).freighterApi ??
    (window as unknown as Record<string, unknown>).freighter;
  return (candidate as FreighterLike) ?? null;
}

export default function CheckoutPage(): React.ReactElement {
  const { api } = useSession();
  const [number, setNumber] = useState("");
  const [invoice, setInvoice] = useState<InvoiceRecord | null>(null);
  const [wallet, setWallet] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  async function lookupNumber(value: string): Promise<void> {
    setError(null);
    setResult(null);
    setInvoice(null);
    setBusy(true);
    try {
      const found = await api.invoices.public(value.trim().toUpperCase());
      setInvoice(found);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "invoice lookup failed");
    } finally {
      setBusy(false);
    }
  }

  async function lookup(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    await lookupNumber(number);
  }

  // The extension and merchant apps link here with ?invoice=NUMBER.
  useEffect(() => {
    const preset = new URLSearchParams(window.location.search).get("invoice");
    if (!preset) return;
    setNumber(preset);
    void lookupNumber(preset);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function connect(): Promise<void> {
    const walletApi = freighter();
    if (!walletApi) {
      setError("No Stellar wallet detected. Install Freighter to pay from the browser.");
      return;
    }
    try {
      const address = walletApi.getAddress
        ? await walletApi.getAddress().then((value) => (typeof value === "string" ? value : value.address))
        : await walletApi.getPublicKey?.();
      if (!address) throw new Error("wallet did not return an address");
      setWallet(address);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "could not connect wallet");
    }
  }

  async function pay(): Promise<void> {
    if (!invoice) return;
    setBusy(true);
    setError(null);
    try {
      const walletApi = freighter();
      if (!walletApi || !wallet) throw new Error("connect a wallet first");
      const intent = await api.invoices.payIntent(invoice.number);
      const signed = await walletApi.signTransaction(intent.xdr, {
        networkPassphrase: intent.networkPassphrase,
      });
      const submitted = await api.raw<{ hash: string; status: string }>(
        "POST",
        "/v1/transactions/submit",
        { xdr: signed.signedTxXdr },
      );
      setResult(
        submitted.status === "SUCCESS"
          ? `Payment confirmed: ${submitted.hash}`
          : `Transaction ${submitted.status}: ${submitted.hash}`,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "payment failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="wp-container checkout-shell">
      <div className="checkout-brand">
        <Brand />
        <Badge tone="neutral">Stellar · Soroban</Badge>
      </div>

      <Card>
        <form onSubmit={lookup} className="wp-stack">
          <Field label="Invoice number" hint="Example: INV-202611-A1B2C3">
            <Input value={number} onChange={setNumber} placeholder="INV-…" required />
          </Field>
          <Button type="submit" loading={busy}>
            Find invoice
          </Button>
        </form>
      </Card>

      {error ? (
        <div style={{ marginTop: 16 }}>
          <Alert tone="error">{error}</Alert>
        </div>
      ) : null}

      {invoice ? (
        <div style={{ marginTop: 16 }}>
          <Card>
            <div className="wp-row wp-between">
              <div>
                <div className="wp-label">{invoice.number}</div>
                <div className="checkout-amount">{formatAmount(invoice.amount)}</div>
                <div className="wp-muted">
                  Due {new Date(invoice.dueAt).toLocaleDateString()} · {invoice.memo ?? "No memo"}
                </div>
              </div>
              <Badge tone={statusTone(invoice.status)}>{invoice.status}</Badge>
            </div>

            <div className="checkout-actions">
              {wallet ? (
                <div className="wp-mono">Wallet {wallet.slice(0, 8)}…{wallet.slice(-6)}</div>
              ) : (
                <Button variant="secondary" onClick={connect}>
                  Connect wallet
                </Button>
              )}
              <Button
                onClick={pay}
                loading={busy}
                disabled={!wallet || invoice.status !== "OPEN"}
              >
                Pay invoice
              </Button>
            </div>
          </Card>
        </div>
      ) : null}

      {result ? (
        <div style={{ marginTop: 16 }}>
          <Alert tone="success">{result}</Alert>
        </div>
      ) : null}

      <p className="checkout-footer">
        Payments settle on the Stellar network. Contract addresses are configured by the operator;
        this app never claims a payment succeeded without a network response.
      </p>
    </main>
  );
}
