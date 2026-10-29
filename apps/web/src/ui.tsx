import { type ReactNode, useId, useState } from "react";
import { Icon } from "./icons";
import { Link } from "./link";
import { navigate } from "./router";

/** `historyBack` goes back where you came from, and to `to` only when there's nowhere to go back to. */
export function BackButton({
  to,
  label,
  historyBack,
}: {
  to: string;
  label: string;
  historyBack?: boolean;
}) {
  const back = () => {
    if (historyBack && history.length > 1) history.back();
    else navigate(to);
  };
  return (
    <button type="button" className="btn sm ghost back" onClick={back}>
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

/** Every panel's title looks the same. */
export function Panel({
  title,
  className,
  children,
}: {
  title?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={className ? `panel ${className}` : "panel"}>
      {title && <h3 className="section-title">{title}</h3>}
      {children}
    </div>
  );
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
  // Radios: Tab reaches the group once, and the arrow keys pick.
  const name = useId();
  return (
    <div className="seg">
      {options.map(([v, label]) => (
        <label key={String(v)} className={value === v ? "active" : ""}>
          <input
            type="radio"
            className="sr-only"
            name={name}
            checked={value === v}
            onChange={() => onChange(v)}
          />
          {label}
        </label>
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

// The efforts Settings and a bot offer, so a new one is added in one place.
export const EFFORTS = [
  ["low", "Low"],
  ["medium", "Medium"],
  ["high", "High"],
  ["xhigh", "Extra high"],
  ["max", "Max"],
] as const;
