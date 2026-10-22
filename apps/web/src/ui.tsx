import { type ReactNode, useState } from "react";
import { Icon } from "./icons";
import { Link } from "./link";
import { navigate } from "./router";

export function BackButton({ to, label }: { to: string; label: string }) {
  return (
    <button type="button" className="btn sm ghost back" onClick={() => navigate(to)}>
      <Icon name="chevron" />
      {label}
    </button>
  );
}

export function BackHead({
  to,
  label,
  children,
}: {
  to: string;
  label: string;
  children?: ReactNode;
}) {
  return (
    <div className="page-head">
      <BackButton to={to} label={label} />
      {children !== undefined && (
        <>
          <span className="spacer" />
          {children}
        </>
      )}
    </div>
  );
}

/** `children` go on the left, e.g. an Add button. */
export function SaveBar({
  error,
  disabled,
  onSave,
  label = "Save",
  children,
}: {
  error: string;
  disabled: boolean;
  onSave: () => void;
  label?: string;
  children?: ReactNode;
}) {
  return (
    <>
      {error && <div className="form-error">{error}</div>}
      <div className="form-actions">
        {children !== undefined && (
          <>
            {children}
            <span className="spacer" />
          </>
        )}
        <button type="button" className="btn accent" disabled={disabled} onClick={onSave}>
          {label}
        </button>
      </div>
    </>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

/** `empty` is said in a row of its own, for a list with nothing in it. */
export function Group({
  title,
  className,
  empty,
  children,
}: {
  title?: ReactNode;
  className?: string;
  empty?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className={className ? `group ${className}` : "group"}>
      {title && <h2>{title}</h2>}
      <div className="group-box">
        {children}
        {empty && (
          <div className="row">
            <span className="muted">{empty}</span>
          </div>
        )}
      </div>
    </section>
  );
}

export function Row({
  label,
  sub,
  children,
}: {
  label: ReactNode;
  sub?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="row">
      <div className="txt">
        <b>{label}</b>
        {sub}
      </div>
      {children}
    </div>
  );
}

/**
 * `snippet` stands instead of `label` for text that isn't a name. `trailing`, e.g. a switch, sits
 * after the link in the same row.
 */
export function LinkRow({
  to,
  label,
  snippet,
  className,
  trailing,
  children,
}: {
  to: string;
  label?: ReactNode;
  snippet?: ReactNode;
  className?: string;
  trailing?: ReactNode;
  children?: ReactNode;
}) {
  const row = className ? `row ${className}` : "row";
  const link = (
    <Link className={trailing === undefined ? `${row} row-link` : "row-main"} to={to}>
      {snippet === undefined ? (
        <div className="txt">
          <b>{label}</b>
        </div>
      ) : (
        <div className="txt snippet">{snippet}</div>
      )}
      {children}
      <Icon name="chevron" className="chev" />
    </Link>
  );
  if (trailing === undefined) return link;
  return (
    <div className={row}>
      {link}
      {trailing}
    </div>
  );
}

/** Every "More": rare settings behind one click. */
export function Disclosure({
  label,
  open: openAtFirst = false,
  children,
}: {
  label: ReactNode;
  open?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(openAtFirst);
  return (
    <div className={`disclosure ${open ? "open" : ""}`}>
      <button type="button" className="fold" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="chevron" />
        <span className="fold-text">{label}</span>
      </button>
      {open && children}
    </div>
  );
}

export function Seg<T extends string | number | boolean>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: readonly (readonly [T, ReactNode])[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="seg">
      {options.map(([v, label]) => (
        <button
          type="button"
          key={String(v)}
          className={value === v ? "active" : ""}
          aria-pressed={value === v}
          onClick={() => onChange(v)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function Select<T extends string | number>({
  label,
  value,
  options,
  onChange,
  className,
  disabled,
}: {
  label: string;
  value: T;
  options: readonly (readonly [T, string])[];
  onChange: (value: T) => void;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <select
      className={className}
      aria-label={label}
      value={String(value)}
      disabled={disabled}
      onChange={(e) => {
        const picked = options.find(([v]) => String(v) === e.target.value);
        if (picked) onChange(picked[0]);
      }}
    >
      {options.map(([v, text]) => (
        <option key={String(v)} value={String(v)}>
          {text}
        </option>
      ))}
    </select>
  );
}

// The models and efforts Settings and a bot offer, so a new one is added in one place.
export const CHAT_MODELS = [
  ["claude-haiku-5-5", "Haiku 5.5, asks Opus for hard parts"],
  ["claude-opus-5-5", "Opus 5.5"],
] as const;
export const MODELS = [
  ["claude-haiku-5-5", "Haiku 5.5"],
  ["claude-opus-5-5", "Opus 5.5"],
] as const;
export const EFFORTS = [
  ["low", "Low"],
  ["medium", "Medium"],
  ["high", "High"],
  ["xhigh", "Extra high"],
  ["max", "Max"],
] as const;
