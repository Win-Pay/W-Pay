import type { CSSProperties, ReactNode } from "react";

type Variant = "primary" | "secondary" | "danger";
type BadgeTone = "neutral" | "success" | "warning" | "danger";

export function Button(props: {
  children: ReactNode;
  onClick?: () => void;
  type?: "button" | "submit";
  variant?: Variant;
  disabled?: boolean;
  loading?: boolean;
  small?: boolean;
  style?: CSSProperties;
}): ReactNode {
  const classes = ["wp-btn"];
  if (props.variant === "secondary") classes.push("wp-btn-secondary");
  if (props.variant === "danger") classes.push("wp-btn-danger");
  if (props.small) classes.push("wp-btn-sm");
  return (
    <button
      type={props.type ?? "button"}
      className={classes.join(" ")}
      onClick={props.onClick}
      disabled={props.disabled || props.loading}
      style={props.style}
    >
      {props.loading ? <span className="wp-spinner" aria-hidden /> : null}
      {props.children}
    </button>
  );
}

export function Card(props: { children: ReactNode; title?: string; description?: string }): ReactNode {
  return (
    <section className="wp-card">
      {props.title ? <h2 className="wp-card-title">{props.title}</h2> : null}
      {props.description ? <p className="wp-muted">{props.description}</p> : null}
      {props.children}
    </section>
  );
}

export function Field(props: {
  label: string;
  children: ReactNode;
  error?: string;
  hint?: string;
}): ReactNode {
  return (
    <label className="wp-field">
      <span className="wp-label">{props.label}</span>
      {props.children}
      {props.hint ? <span className="wp-muted">{props.hint}</span> : null}
      {props.error ? <span className="wp-error-text">{props.error}</span> : null}
    </label>
  );
}

export function Input(props: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  required?: boolean;
  min?: string;
  max?: string;
  step?: string;
  disabled?: boolean;
  name?: string;
}): ReactNode {
  return (
    <input
      className="wp-input"
      value={props.value}
      onChange={(event) => props.onChange(event.target.value)}
      placeholder={props.placeholder}
      type={props.type ?? "text"}
      required={props.required}
      min={props.min}
      max={props.max}
      step={props.step}
      disabled={props.disabled}
      name={props.name}
    />
  );
}

export function Textarea(props: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
}): ReactNode {
  return (
    <textarea
      className="wp-textarea"
      value={props.value}
      onChange={(event) => props.onChange(event.target.value)}
      placeholder={props.placeholder}
      rows={props.rows ?? 3}
    />
  );
}

export function Select(props: {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}): ReactNode {
  return (
    <select className="wp-select" value={props.value} onChange={(event) => props.onChange(event.target.value)}>
      {props.options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export function Badge(props: { children: ReactNode; tone?: BadgeTone }): ReactNode {
  const tone = props.tone ?? "neutral";
  const classes = ["wp-badge"];
  if (tone !== "neutral") classes.push(`wp-badge-${tone}`);
  return <span className={classes.join(" ")}>{props.children}</span>;
}

/** Maps a domain status to a badge tone, so every app colours consistently. */
export function statusTone(status: string): BadgeTone {
  const normalized = status.toUpperCase();
  if (["ACTIVE", "SETTLED", "PAID", "RELEASED", "APPROVED", "SUCCESS", "OK", "DELIVERED"].includes(normalized)) {
    return "success";
  }
  if (["PENDING", "OPEN", "FUNDED", "CREATED", "DISPUTED", "SCHEDULED"].includes(normalized)) {
    return "warning";
  }
  if (["FAILED", "CANCELLED", "REJECTED", "SUSPENDED", "CLOSED", "EXPIRED", "LAPSED", "REFUNDED"].includes(normalized)) {
    return "danger";
  }
  return "neutral";
}

export function Alert(props: { children: ReactNode; tone?: "info" | "error" | "success" }): ReactNode {
  const classes = ["wp-alert"];
  if (props.tone === "error") classes.push("wp-alert-error");
  if (props.tone === "success") classes.push("wp-alert-success");
  return <div className={classes.join(" ")}>{props.children}</div>;
}

export function Stat(props: { label: string; value: ReactNode; hint?: string }): ReactNode {
  return (
    <div className="wp-card">
      <div className="wp-label">{props.label}</div>
      <div className="wp-amount">{props.value}</div>
      {props.hint ? <div className="wp-muted">{props.hint}</div> : null}
    </div>
  );
}

export function EmptyState(props: { title: string; description?: string }): ReactNode {
  return (
    <div className="wp-empty">
      <strong>{props.title}</strong>
      {props.description ? <p className="wp-muted">{props.description}</p> : null}
    </div>
  );
}

export function Spinner(): ReactNode {
  return <span className="wp-spinner" aria-label="loading" />;
}

export function PageHeader(props: {
  title: string;
  description?: string;
  actions?: ReactNode;
}): ReactNode {
  return (
    <div className="wp-row wp-between" style={{ marginBottom: 20 }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 26, letterSpacing: "-0.02em" }}>{props.title}</h1>
        {props.description ? <p className="wp-muted">{props.description}</p> : null}
      </div>
      {props.actions}
    </div>
  );
}

export function Brand(): ReactNode {
  return (
    <span className="wp-brand">
      <svg
        className="wp-brand-mark"
        viewBox="0 0 64 64"
        aria-hidden="true"
        focusable="false"
      >
        <defs>
          <linearGradient
            id="wpay-brand-gradient"
            x1="8"
            y1="4"
            x2="56"
            y2="62"
            gradientUnits="userSpaceOnUse"
          >
            <stop offset="0" stopColor="#5B8CFF" />
            <stop offset="0.55" stopColor="#6E7BFF" />
            <stop offset="1" stopColor="#8B5CF6" />
          </linearGradient>
        </defs>
        <rect x="2" y="2" width="60" height="60" rx="16" fill="url(#wpay-brand-gradient)" />
        <rect
          x="2.75"
          y="2.75"
          width="58.5"
          height="58.5"
          rx="15.25"
          fill="none"
          stroke="#ffffff"
          strokeOpacity="0.22"
          strokeWidth="1.5"
        />
        <path
          d="M15 21 24.5 45 32 30.5 39.5 45 49 21"
          fill="none"
          stroke="#ffffff"
          strokeWidth="5.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M49 8.5 50.5 11.7 53.7 13.2 50.5 14.7 49 17.9 47.5 14.7 44.3 13.2 47.5 11.7Z"
          fill="#3EE8C0"
        />
      </svg>
      <span className="wp-brand-word">
        W<span className="wp-brand-accent">Pay</span>
      </span>
    </span>
  );
}
