/**
 * Wallet abstraction. Freighter and similar extensions can be adapted by
 * implementing `WalletSigner`; `keypairSigner` covers scripts and the API.
 */
import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";

export interface SignedTransaction {
  signedTxXdr: string;
  signerAddress?: string;
}

export interface WalletSigner {
  publicKey: string;
  signTransaction(
    xdr: string,
    options: { networkPassphrase: string },
  ): Promise<SignedTransaction>;
  /** SEP-53 style message signing, used for wallet login. */
  signMessage?(message: string): Promise<{ signature: string; signerAddress?: string }>;
}

/**
 * Adapts the Freighter browser API (`window.freighterApi`) to `WalletSigner`.
 * The interface is structural so no Freighter dependency is required.
 */
export function freighterSigner(
  freighter: {
    signTransaction(
      xdr: string,
      options: { networkPassphrase: string },
    ): Promise<{ signedTxXdr: string; signerAddress?: string }>;
    signMessage?: (message: string) => Promise<{ signedMessage: string; signerAddress?: string }>;
  },
  publicKey: string,
): WalletSigner {
  return {
    publicKey,
    async signTransaction(xdr, options) {
      const result = await freighter.signTransaction(xdr, options);
      return { signedTxXdr: result.signedTxXdr, signerAddress: result.signerAddress };
    },
    async signMessage(message) {
      if (!freighter.signMessage) throw new Error("wallet does not support message signing");
      // Freighter already returns the base64-encoded SEP-53 signature.
      const result = await freighter.signMessage(message);
      return { signature: result.signedMessage, signerAddress: result.signerAddress };
    },
  };
}

/** Server-side signer. Keep the secret in a secret manager, never in source. */
export function keypairSigner(secret: string, networkPassphrase: string): WalletSigner {
  const keypair = Keypair.fromSecret(secret);
  return {
    publicKey: keypair.publicKey(),
    async signTransaction(xdr: string) {
      const transaction = TransactionBuilder.fromXDR(xdr, networkPassphrase);
      transaction.sign(keypair);
      return { signedTxXdr: transaction.toXDR(), signerAddress: keypair.publicKey() };
    },
    async signMessage(message: string) {
      return {
        signature: keypair.sign(Buffer.from(message, "utf8")).toString("base64"),
        signerAddress: keypair.publicKey(),
      };
    },
  };
}

/** Reads an unsigned XDR, signs it with the wallet, and returns the signed XDR. */
export async function signTransactionXdr(
  signer: WalletSigner,
  xdr: string,
  networkPassphrase: string,
): Promise<string> {
  const signed = await signer.signTransaction(xdr, { networkPassphrase });
  return signed.signedTxXdr;
}
