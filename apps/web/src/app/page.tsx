"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { PublicInvoiceRecord } from "@wpay/types";
import { Alert, Badge, Brand, Button, Card, Field, Input, statusTone } from "@wpay/ui";
import { formatAmount, useSession, type FreighterLike } from "@wpay/hooks";

function freighter(): FreighterLike | null {
  if (typeof window === "undefined") return null;
  const candidate = (window as unknown as Record<string, unknown>).freighterApi ??
    (window as unknown as Record<string, unknown>).freighter;
  return (candidate as FreighterLike) ?? null;
}

function shortAddress(address: string): string {
  return `${address.slice(0, 8)}…${address.slice(-6)}`;
}

function assetLabel(token: string): string {
  return token === "native" ? "XLM" : shortAddress(token);
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function explorerNetwork(networkPassphrase: string | null): "public" | "testnet" | null {
  if (!networkPassphrase) return "testnet";
  if (networkPassphrase.startsWith("Public Global Stellar Network")) return "public";
  if (networkPassphrase.startsWith("Test SDF Network")) return "testnet";
  return null;
}

function explorerUrl(hash: string, networkPassphrase: string | null): string | null {
  const network = explorerNetwork(networkPassphrase);
  return network ? `https://stellar.expert/explorer/${network}/tx/${hash}` : null;
}

type Phase = "idle" | "signing" | "submitting" | "confirming" | "confirmed";

export default function CheckoutPage(): React.ReactElement {
  const session = useSession();
  const { api } = session;
  const [number, setNumber] = useState("");
  const [invoice, setInvoice] = useState<PublicInvoiceRecord | null>(null);
  const [wallet, setWallet] = useState<string | null>(null);
  const [networkPassphrase, setNetworkPassphrase] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [ledger, setLedger] = useState<number | null>(null);

  const expired = useMemo(
    () =>
      Boolean(invoice && invoice.status === "OPEN" && new Date(invoice.dueAt).getTime() < Date.now()),
    [invoice],
  );
  const paid = invoice?.status === "PAID";
  const explorer = txHash ? explorerUrl(txHash, networkPassphrase) : null;

  async function lookupNumber(value: string): Promise<void> {
    setError(null);
    setTxHash(null);
    setLedger(null);
    setPhase("idle");
    setInvoice(null);
    setBusy(true);
    try {
      const found = await api.invoices.public(value.trim().toUpperCase());
      setInvoice(found);
      if (found.txHash) setTxHash(found.txHash);
      if (found.paidAt) setPhase("confirmed");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "invoice lookup failed");
    } finally {
      setBusy(false);
    }
  }

  async function lookup(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!number.trim()) {
      setError("Enter an invoice number.");
      return;
    }
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
    setError(null);
    const walletApi = freighter();
    if (!walletApi) {
      setError(
        "No Stellar wallet detected. Install the Freighter browser extension, then reload this page.",
      );
      return;
    }
    try {
      const value = walletApi.getAddress
        ? await walletApi.getAddress().then((result) => (typeof result === "string" ? result : result.address))
        : await walletApi.getPublicKey?.();
      if (!value) throw new Error("wallet did not return an address");
      setWallet(value);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "could not connect wallet");
    }
  }

  function disconnect(): void {
    setWallet(null);
    setPhase("idle");
    setError(null);
  }

  async function pay(): Promise<void> {
    if (!invoice) return;
    if (expired) {
      setError("This invoice has passed its due date. Ask the merchant for a new invoice.");
      return;
    }
    setBusy(true);
    setError(null);
    setTxHash(null);
    setLedger(null);
    try {
      const walletApi = freighter();
      if (!walletApi || !wallet) throw new Error("connect a wallet first");

      setPhase("signing");
      const intent = await api.invoices.payIntent(invoice.number, wallet);
      setNetworkPassphrase(intent.networkPassphrase);
      const signed = await walletApi.signTransaction(intent.xdr, {
        networkPassphrase: intent.networkPassphrase,
        address: wallet,
      });

      setPhase("submitting");
      const submitted = await api.raw<{ hash: string; status: string; ledger?: number | null }>(
        "POST",
        "/v1/transactions/submit",
        { xdr: signed.signedTxXdr },
      );
      setTxHash(submitted.hash);
      setLedger(submitted.ledger ?? null);
      if (submitted.status !== "SUCCESS") {
        setPhase("idle");
        throw new Error(`transaction ${submitted.status.toLowerCase()} (${submitted.hash})`);
      }

      setPhase("confirming");
      const confirmed = await api.invoices.confirmPayment(invoice.number, submitted.hash);
      setInvoice({ ...invoice, ...confirmed });
      if (confirmed.txHash) setTxHash(confirmed.txHash);
      setPhase("confirmed");
    } catch (cause) {
      setPhase("idle");
      setError(cause instanceof Error ? cause.message : "payment failed");
    } finally {
      setBusy(false);
    }
  }

  if (session.configError) {
    return (
      <main className="wp-container checkout-shell">
        <div className="checkout-brand">
          <Brand />
        </div>
        <Card title="Checkout unavailable">
          <Alert tone="error">{session.configError}</Alert>
          <p className="wp-muted">
            This deployment is missing NEXT_PUBLIC_API_URL. An operator must point it at the
            public W-Pay API before invoices can be paid.
          </p>
        </Card>
      </main>
    );
  }

  const steps = [
    { key: "invoice", label: "Invoice", done: Boolean(invoice) },
    { key: "wallet", label: "Wallet", done: Boolean(wallet) },
    {
      key: "sign",
      label: "Sign & submit",
      done: phase === "confirming" || phase === "confirmed",
    },
    { key: "confirmed", label: "Confirmed", done: paid || phase === "confirmed" },
  ];

  return (
    <main className="wp-container checkout-shell">
      <div className="checkout-brand">
        <Brand />
        <div className="wp-row">
          <Badge tone="neutral">Stellar · Soroban</Badge>
          <Link href="/landing" className="checkout-link">
            About W-Pay
          </Link>
        </div>
      </div>

      <ol className="checkout-steps" aria-label="Payment progress">
        {steps.map((step) => (
          <li key={step.key} data-done={step.done} aria-current={step.done ? "step" : undefined}>
            <span aria-hidden>{step.done ? "✓" : "•"}</span> {step.label}
          </li>
        ))}
      </ol>

      <Card>
        <form onSubmit={lookup} className="wp-stack">
          <Field label="Invoice number" hint="Example: INV-202611-A1B2C3">
            <Input value={number} onChange={setNumber} placeholder="INV-…" required />
          </Field>
          <Button type="submit" loading={busy && !invoice}>
            Find invoice
          </Button>
        </form>
      </Card>

      {error ? (
        <div className="checkout-gap">
          <Alert tone="error">{error}</Alert>
          {invoice && invoice.status === "OPEN" && !expired ? (
            <div className="checkout-actions">
              <Button variant="secondary" onClick={pay} loading={busy}>
                Retry payment
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {invoice ? (
        <div className="checkout-gap">
          <Card>
            <div className="checkout-merchant">
              <div className="checkout-avatar" aria-hidden>
                {(invoice.merchantName ?? "W").slice(0, 1).toUpperCase()}
              </div>
              <div>
                <div className="wp-label">Paying</div>
                <strong>{invoice.merchantName ?? "W-Pay merchant"}</strong>
                {invoice.merchantWebsite ? (
                  <div>
                    <a href={invoice.merchantWebsite} target="_blank" rel="noreferrer noopener">
                      {invoice.merchantWebsite}
                    </a>
                  </div>
                ) : null}
                {invoice.merchantDescription ? (
                  <p className="wp-muted">{invoice.merchantDescription}</p>
                ) : null}
              </div>
              <Badge tone={statusTone(invoice.status)}>{invoice.status}</Badge>
            </div>

            <div className="checkout-amount-row">
              <div>
                <div className="wp-label">Amount due</div>
                <div className="checkout-amount">{formatAmount(invoice.amount)}</div>
                <div className="wp-muted">
                  {assetLabel(invoice.token)} · {invoice.number}
                </div>
              </div>
              <div className="checkout-meta">
                <div>
                  <span className="wp-label">Due</span>
                  <span>{formatDate(invoice.dueAt)}</span>
                </div>
                {invoice.memo ? (
                  <div>
                    <span className="wp-label">Memo</span>
                    <span className="wp-mono">{invoice.memo}</span>
                  </div>
                ) : null}
              </div>
            </div>

            {invoice.fee && invoice.net ? (
              <dl className="checkout-breakdown">
                <div>
                  <dt>Invoice amount</dt>
                  <dd>{formatAmount(invoice.amount)}</dd>
                </div>
                <div>
                  <dt>
                    Platform fee ({(invoice.feeBps / 100).toFixed(2)}%)
                    <span className="wp-muted"> included, deducted from merchant proceeds</span>
                  </dt>
                  <dd>{formatAmount(invoice.fee)}</dd>
                </div>
                <div>
                  <dt>Merchant receives</dt>
                  <dd>{formatAmount(invoice.net)}</dd>
                </div>
              </dl>
            ) : null}

            {expired ? (
              <div className="checkout-gap-sm">
                <Alert tone="error">
                  This invoice expired on {formatDate(invoice.dueAt)}. Ask the merchant for a new
                  invoice.
                </Alert>
              </div>
            ) : null}

            {!paid && invoice.status !== "OPEN" && !expired ? (
              <div className="checkout-gap-sm">
                <Alert tone="info">This invoice is {invoice.status.toLowerCase()} and cannot be paid.</Alert>
              </div>
            ) : null}

            <div className="checkout-actions">
              {wallet ? (
                <div className="checkout-wallet">
                  <span className="wp-mono" title={wallet}>
                    Wallet {shortAddress(wallet)}
                  </span>
                  <Button variant="secondary" small onClick={disconnect}>
                    Disconnect
                  </Button>
                </div>
              ) : (
                <Button variant="secondary" onClick={connect}>
                  Connect wallet
                </Button>
              )}
              <Button
                onClick={pay}
                loading={busy && Boolean(invoice) && phase !== "idle"}
                disabled={!wallet || invoice.status !== "OPEN" || expired || busy}
              >
                Pay invoice
              </Button>
            </div>

            {busy && phase !== "idle" ? (
              <p className="wp-muted" role="status">
                {phase === "signing"
                  ? "Waiting for your wallet to sign the transaction…"
                  : phase === "submitting"
                    ? "Submitting the signed transaction to Stellar…"
                    : "Confirming the transaction on chain…"}
              </p>
            ) : null}
          </Card>
        </div>
      ) : null}

      {paid || phase === "confirmed" ? (
        <div className="checkout-gap">
          <Alert tone="success">
            {txHash
              ? `Payment confirmed on chain: ${txHash}`
              : "This invoice has already been paid."}
          </Alert>
          <Card title="Payment receipt">
            <dl className="checkout-breakdown">
              <div>
                <dt>Merchant</dt>
                <dd>{invoice?.merchantName ?? "W-Pay merchant"}</dd>
              </div>
              <div>
                <dt>Amount paid</dt>
                <dd>{invoice ? formatAmount(invoice.amount) : "—"}</dd>
              </div>
              {invoice?.fee && invoice.net ? (
                <>
                  <div>
                    <dt>Platform fee</dt>
                    <dd>{formatAmount(invoice.fee)}</dd>
                  </div>
                  <div>
                    <dt>Merchant receives</dt>
                    <dd>{formatAmount(invoice.net)}</dd>
                  </div>
                </>
              ) : null}
              <div>
                <dt>Paid</dt>
                <dd>{formatDate(invoice?.paidAt ?? null)}</dd>
              </div>
              {txHash ? (
                <div>
                  <dt>Transaction</dt>
                  <dd className="wp-mono" title={txHash}>
                    {txHash}
                    {ledger ? <span className="wp-muted"> · ledger {ledger}</span> : null}
                  </dd>
                </div>
              ) : null}
            </dl>
            {explorer ? (
              <a
                className="checkout-explorer"
                href={explorer}
                target="_blank"
                rel="noreferrer noopener"
              >
                View transaction on Stellar Expert ↗
              </a>
            ) : null}
          </Card>
        </div>
      ) : null}

      <p className="checkout-footer">
        Payments settle on the Stellar network. Contract addresses are configured by the operator;
        this app never claims a payment succeeded without a network response.{" "}
        <Link href="/landing">Learn more about W-Pay</Link>.
      </p>
    </main>
  );
}
