"use client";

/**
 * React hooks shared by the dashboard applications.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WPayApi } from "@wpay/sdk";
import type { WalletSigner } from "@wpay/sdk";

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

const API_URL_KEY = "wpay.apiUrl";
const TOKEN_KEY = "wpay.token";

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
  setToken: (token: string | null) => void;
  setUser: (user: SessionUser | null) => void;
  logout: () => void;
}

/**
 * API client plus token persistence. The default URL comes from
 * NEXT_PUBLIC_API_URL (or VITE_API_URL for the mobile app).
 */
export function useSession(defaultApiUrl?: string): Session {
  const apiUrl = useMemo(() => {
    if (defaultApiUrl) return defaultApiUrl;
    if (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_API_URL) {
      return process.env.NEXT_PUBLIC_API_URL;
    }
    return "http://localhost:4000";
  }, [defaultApiUrl]);

  const [token, setTokenState] = useState<string | null>(null);
  const [user, setUser] = useState<SessionUser | null>(null);

  const api = useMemo(() => new WPayApi({ baseUrl: apiUrl }), [apiUrl]);

  useEffect(() => {
    const stored = typeof window !== "undefined" ? window.localStorage.getItem(TOKEN_KEY) : null;
    if (stored) {
      api.setToken(stored);
      setTokenState(stored);
    }
  }, [api]);

  const setToken = useCallback(
    (next: string | null) => {
      api.setToken(next ?? undefined);
      setTokenState(next);
      if (typeof window !== "undefined") {
        if (next) window.localStorage.setItem(TOKEN_KEY, next);
        else window.localStorage.removeItem(TOKEN_KEY);
      }
    },
    [api],
  );

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
  }, [setToken]);

  return { api, token, user, setToken, setUser, logout };
}

/** Wallet connection state kept in localStorage; signing is delegated to the wallet. */
export interface WalletState {
  address: string | null;
  signer: WalletSigner | null;
  connect: (address: string, signer: WalletSigner) => void;
  disconnect: () => void;
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
