"use client";

/**
 * React hooks shared by the dashboard applications.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WPayApi } from "@wpay/sdk";
import type { AuthSession, WalletSigner } from "@wpay/sdk";

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
  setData: (value: T | null) => void;
}

/** Runs an async function on mount and whenever `deps` change. */
export function useAsync<T>(loader: () => Promise<T>, deps: unknown[] = []): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    setLoading(true);
    setError(null);
    loader()
      .then((value) => {
        if (mounted.current) setData(value);
      })
      .catch((cause: unknown) => {
        if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (mounted.current) setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);
  return { data, loading, error, reload, setData };
}

export function usePolling(callback: () => void, intervalMs: number, enabled = true): void {
  const saved = useRef(callback);
  useEffect(() => {
    saved.current = callback;
  }, [callback]);
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => saved.current(), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, enabled]);
}

// Legacy keys from builds that persisted credentials; removed on mount.
const LEGACY_TOKEN_KEY = "wpay.token";
const LEGACY_REFRESH_KEY = "wpay.refresh";
/**
 * Resolves the backend URL without silently pointing production builds at
 * localhost. A missing NEXT_PUBLIC_API_URL is a deployment error the UI must
 * show; only local origins fall back to the development API.
 */
export function resolveApiBaseUrl(explicit?: string): { url: string; error: string | null } {
  const configured =
    explicit ||
    (typeof process !== "undefined" ? process.env?.NEXT_PUBLIC_API_URL : undefined);
  if (configured) return { url: configured.replace(/\/$/, ""), error: null };

  const hostname =
    typeof window !== "undefined" ? window.location.hostname : "localhost";
  if (hostname === "localhost" || hostname === "127.0.0.1") {
    return { url: "http://localhost:4000", error: null };
  }
  return {
    url: "https://configuration-required.invalid",
    error:
      "NEXT_PUBLIC_API_URL is not configured for this deployment. Set it to the public backend URL and rebuild.",
  };
}

export interface SessionUser {
  id: string;
  email: string;
  role: string;
  stellarAddress: string | null;
  displayName: string | null;
}

export interface Session {
  api: WPayApi;
  token: string | null;
  user: SessionUser | null;
  configError: string | null;
  /** True while a stored refresh token is being exchanged for a session. */
  restoring: boolean;
  setToken: (token: string | null) => void;
  setUser: (user: SessionUser | null) => void;
  setSession: (session: AuthSession) => void;
  logout: () => void;
}

/**
 * API client plus session persistence. Access and CSRF tokens live in memory;
 * the rotating refresh token is an HttpOnly cookie, so a reload can restore
 * the session without JavaScript ever reading it.
 * The default URL comes from NEXT_PUBLIC_API_URL (or VITE_API_URL for mobile).
 */
export function useSession(defaultApiUrl?: string): Session {
  const resolution = useMemo(() => resolveApiBaseUrl(defaultApiUrl), [defaultApiUrl]);

  const [token, setTokenState] = useState<string | null>(null);
  const [user, setUser] = useState<SessionUser | null>(null);
  const [restoring, setRestoring] = useState(true);
  const refreshInFlight = useRef<Promise<string | null> | null>(null);
  const csrfRef = useRef<string | null>(null);

  const api = useMemo(() => new WPayApi({ baseUrl: resolution.url }), [resolution.url]);

  const setToken = useCallback(
    (next: string | null) => {
      api.setToken(next ?? undefined);
      setTokenState(next);
    },
    [api],
  );

  const setSession = useCallback(
    (session: AuthSession) => {
      api.setToken(session.accessToken);
      setTokenState(session.accessToken);
      setUser(session.user);
      csrfRef.current = session.csrfToken;
      setRestoring(false);
    },
    [api],
  );

  const refreshSession = useCallback(async (): Promise<string | null> => {
    if (typeof window === "undefined") return null;
    if (refreshInFlight.current) return refreshInFlight.current;
    const run = (async () => {
      let csrfToken = csrfRef.current;
      try {
        if (!csrfToken) {
          csrfToken = (await api.auth.csrf()).csrfToken;
        }
        // The refresh token is an httpOnly cookie; this request only carries
        // the CSRF header, so an XSS cannot read or mint the refresh token.
        const session = await api.auth.refresh(csrfToken);
        api.setToken(session.accessToken);
        setTokenState(session.accessToken);
        setUser(session.user);
        csrfRef.current = session.csrfToken;
        return session.accessToken;
      } catch {
        api.setToken(undefined);
        setTokenState(null);
        setUser(null);
        csrfRef.current = null;
        return null;
      } finally {
        refreshInFlight.current = null;
      }
    })();
    refreshInFlight.current = run;
    return run;
  }, [api]);

  useEffect(() => {
    api.setUnauthorizedHandler(refreshSession);
    return () => api.setUnauthorizedHandler(undefined);
  }, [api, refreshSession]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    // Older builds persisted access and refresh tokens; remove them and use
    // the httpOnly cookie from now on.
    window.localStorage.removeItem(LEGACY_TOKEN_KEY);
    window.localStorage.removeItem(LEGACY_REFRESH_KEY);
    void refreshSession().finally(() => setRestoring(false));
  }, [refreshSession]);

  const logout = useCallback(() => {
    void (async () => {
      let csrfToken = csrfRef.current;
      if (!csrfToken) {
        try {
          csrfToken = (await api.auth.csrf()).csrfToken;
        } catch {
          return;
        }
      }
      await api.auth.logout(csrfToken).catch(() => undefined);
    })();
    api.setToken(undefined);
    setTokenState(null);
    setUser(null);
    csrfRef.current = null;
    setRestoring(false);
  }, [api]);

  return {
    api,
    token,
    user,
    configError: resolution.error,
    restoring,
    setToken,
    setUser,
    setSession,
    logout,
  };
}

/** Wallet connection state kept in localStorage; signing is delegated to the wallet. */
export interface WalletState {
  address: string | null;
  signer: WalletSigner | null;
  connect: (address: string, signer: WalletSigner) => void;
  disconnect: () => void;
}

/** Minimal surface of the injected Freighter extension. */
export interface FreighterLike {
  getPublicKey?: () => Promise<string>;
  getAddress?: () => Promise<{ address: string } | string>;
  signTransaction: (
    xdr: string,
    options: { networkPassphrase: string; address?: string },
  ) => Promise<{ signedTxXdr: string }>;
  signMessage?: (
    message: string,
    options?: { address?: string },
  ) => Promise<{ signedMessage: string; signerAddress: string }>;
}

/** Returns the injected Freighter API, if the extension is installed. */
export function freighterApi(): FreighterLike | null {
  if (typeof window === "undefined") return null;
  const candidate = (window as unknown as Record<string, unknown>).freighterApi ??
    (window as unknown as Record<string, unknown>).freighter;
  return (candidate as FreighterLike) ?? null;
}

/** Asks Freighter for the active account address. */
export async function freighterAddress(): Promise<string> {
  const wallet = freighterApi();
  if (!wallet) {
    throw new Error("No Stellar wallet detected. Install Freighter to sign transactions.");
  }
  const value = wallet.getAddress
    ? await wallet.getAddress().then((result) => (typeof result === "string" ? result : result.address))
    : await wallet.getPublicKey?.();
  if (!value) throw new Error("wallet did not return an address");
  return value;
}

/** Signs an unsigned XDR with Freighter and returns the signed envelope. */
export async function signWithFreighter(
  xdr: string,
  networkPassphrase: string,
  address?: string,
): Promise<string> {
  const wallet = freighterApi();
  if (!wallet) {
    throw new Error("No Stellar wallet detected. Install Freighter to sign transactions.");
  }
  const signed = await wallet.signTransaction(xdr, { networkPassphrase, address });
  return signed.signedTxXdr;
}

/** Signs a plain-text challenge (SEP-53) with the injected wallet. */
export async function signMessageWithFreighter(
  message: string,
  address?: string,
): Promise<string> {
  const wallet = freighterApi();
  if (!wallet?.signMessage) {
    throw new Error("This wallet cannot sign messages. Use Freighter or sign in with email.");
  }
  const signed = await wallet.signMessage(message, { address });
  return signed.signedMessage;
}

export function useWallet(): WalletState {
  const [address, setAddress] = useState<string | null>(null);
  const [signer, setSigner] = useState<WalletSigner | null>(null);

  const connect = useCallback((nextAddress: string, nextSigner: WalletSigner) => {
    setAddress(nextAddress);
    setSigner(nextSigner);
    if (typeof window !== "undefined") window.localStorage.setItem("wpay.wallet", nextAddress);
  }, []);

  const disconnect = useCallback(() => {
    setAddress(null);
    setSigner(null);
    if (typeof window !== "undefined") window.localStorage.removeItem("wpay.wallet");
  }, []);

  return { address, signer, connect, disconnect };
}

/** Formats stroops for display without pulling in a formatting library. */
export function formatAmount(stroops: string, decimals = 7): string {
  try {
    const value = BigInt(stroops);
    const negative = value < 0n;
    const digits = (negative ? -value : value).toString().padStart(decimals + 1, "0");
    const whole = digits.slice(0, digits.length - decimals);
    const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
    return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
  } catch {
    return stroops;
  }
}
