import type { Metadata } from "next";
import Link from "next/link";
import { Brand } from "@wpay/ui";

export const metadata: Metadata = {
  title: "W-Pay — Stellar payments for modern merchants",
  description:
    "Wallet-signed Stellar and Soroban payments with on-chain verification, transparent fees and reconciliation-ready settlement.",
};

const MERCHANT_URL = "https://wpay-merchant.vercel.app";
const ADMIN_URL = "https://wpay-admin.vercel.app";
const REPO_URL = "https://github.com/Win-Pay/W-Pay";

export default function LandingPage(): React.ReactElement {
  return (
    <>
      <nav className="landing-nav">
        <Brand />
        <div className="landing-nav-links">
          <Link href="/">Checkout</Link>
          <a href={MERCHANT_URL}>Merchant dashboard</a>
          <a href={ADMIN_URL}>Admin</a>
          <a href={`${REPO_URL}#readme`}>Documentation</a>
        </div>
      </nav>

      <header className="landing-hero">
        <div>
          <span className="wp-badge">Stellar · Soroban</span>
          <h1>Accept wallet payments without giving up custody.</h1>
          <p>
            W-Pay lets customers pay invoices directly from Freighter. Every payment is verified on
            chain before an invoice is marked paid, with transparent platform fees and a settlement
            trail your finance team can reconcile.
          </p>
          <div className="landing-cta">
            <Link href="/">Open checkout</Link>
            <a className="secondary" href={MERCHANT_URL}>
              Merchant dashboard
            </a>
            <a className="secondary" href={ADMIN_URL}>
              Admin console
            </a>
          </div>
        </div>

        <div className="landing-preview" aria-label="Checkout preview">
          <div className="landing-preview-row">
            <strong>Northwind Studio</strong>
            <span className="wp-badge">OPEN</span>
          </div>
          <div className="landing-preview-amount">125.0000000 XLM</div>
          <div className="landing-preview-row">
            <span className="wp-muted">Invoice</span>
            <span className="wp-mono">INV-202611-8F2A1C</span>
          </div>
          <div className="landing-preview-row">
            <span className="wp-muted">Platform fee</span>
            <span>2.50%</span>
          </div>
          <div className="landing-preview-row">
            <span className="wp-muted">Merchant receives</span>
            <span>121.8750000 XLM</span>
          </div>
          <div className="landing-preview-row">
            <span className="wp-muted">Settlement</span>
            <span>Verified on Stellar</span>
          </div>
        </div>
      </header>

      <section className="landing-section" aria-labelledby="features-title">
        <h2 id="features-title">Built for verifiable money movement</h2>
        <p className="wp-muted">
          The same API powers checkout, merchant operations and platform administration.
        </p>
        <div className="landing-grid">
          <article className="landing-card">
            <h3>Non-custodial signing</h3>
            <p>
              Customers sign Soroban transactions with Freighter. W-Pay never holds payer keys or
              moves funds on their behalf.
            </p>
          </article>
          <article className="landing-card">
            <h3>On-chain verification</h3>
            <p>
              Invoices and payments become PAID or SETTLED only after the API verifies the
              transaction result, memo, asset and amount on Stellar.
            </p>
          </article>
          <article className="landing-card">
            <h3>Transparent fees</h3>
            <p>
              The platform fee and merchant proceeds are shown before signing. Self-service
              merchants cannot override the platform rate.
            </p>
          </article>
          <article className="landing-card">
            <h3>Reconciliation</h3>
            <p>
              A durable indexer projects contract events into Postgres with retries, dead letters
              and admin-visible recovery status.
            </p>
          </article>
          <article className="landing-card">
            <h3>Webhooks</h3>
            <p>
              Signed delivery with retries and delivery history keeps your own systems in sync with
              payment state changes.
            </p>
          </article>
          <article className="landing-card">
            <h3>Settlements</h3>
            <p>
              Merchants review payment history and settlement windows; operators monitor treasury
              and platform-wide activity.
            </p>
          </article>
        </div>
      </section>

      <section className="landing-section" aria-labelledby="flow-title">
        <h2 id="flow-title">How a payment works</h2>
        <div className="landing-grid">
          <article className="landing-card">
            <h3>1 · Invoice</h3>
            <p>
              The merchant creates an invoice in the dashboard and shares the checkout link or
              invoice number.
            </p>
          </article>
          <article className="landing-card">
            <h3>2 · Sign</h3>
            <p>
              The customer opens checkout, connects Freighter and reviews the amount, fee and
              merchant before signing.
            </p>
          </article>
          <article className="landing-card">
            <h3>3 · Verify</h3>
            <p>
              W-Pay submits the signed transaction, verifies it on chain and issues a receipt with
              the transaction hash and Explorer link.
            </p>
          </article>
        </div>
      </section>

      <div className="landing-status">
        <div className="wp-card">
          <h3 className="wp-card-title">Deployment status</h3>
          <p className="wp-muted">
            The Soroban contracts are deployed on Stellar Testnet. This site is not a mainnet
            service, holds no real funds and has not undergone an independent security audit. The
            hosted dashboards require a configured public API before they can process payments.
          </p>
          <p className="wp-muted">
            Developers can review the architecture, deployment runbooks and security notes in the{" "}
            <a href={REPO_URL}>repository</a>.
          </p>
        </div>
      </div>

      <footer className="landing-footer">
        <Brand /> · Built on Stellar ·{" "}
        <Link href="/">Checkout</Link> · <a href={MERCHANT_URL}>Merchant</a> ·{" "}
        <a href={ADMIN_URL}>Admin</a>
      </footer>
    </>
  );
}
