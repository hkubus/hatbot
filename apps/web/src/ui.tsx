// The pieces most pages are made of: a head with Back, a form's Save, and Settings-style groups of rows.
import type { ReactNode } from "react";
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

/** A page's head: Back, and what the page can do over on the right. */
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

/** The end of a form: what went wrong, if anything, and its button. */
export function SaveBar({
  error,
  disabled,
  onSave,
  label = "Save",
}: {
  error: string;
  disabled: boolean;
  onSave: () => void;
  label?: string;
}) {
  return (
    <>
      {error && <div className="form-error">{error}</div>}
      <div className="form-actions">
        <button type="button" className="btn accent" disabled={disabled} onClick={onSave}>
          {label}
        </button>
      </div>
    </>
  );
}

export function Group({
  title,
  className,
  children,
}: {
  title?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={className ? `group ${className}` : "group"}>
      {title && <h2>{title}</h2>}
      <div className="group-box">{children}</div>
    </section>
  );
}

/** A row of a group: its label with anything under it, and its controls on the right. */
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

/** A row that's a link to its own page; `children` go before the chevron. */
export function LinkRow({
  to,
  label,
  children,
}: {
  to: string;
  label: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Link className="row row-link" to={to}>
      <div className="txt">
        <b>{label}</b>
      </div>
      {children}
      <Icon name="chevron" className="chev" />
    </Link>
  );
}

/** One of a few choices, as buttons side by side. */
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
