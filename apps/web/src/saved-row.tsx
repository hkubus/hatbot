// A Settings row whose field saves when you leave it. It shows the saved value, and a value that
// can't be saved is never silently kept on screen: it says why and the saved value comes back.
import { type InputHTMLAttributes, type ReactNode, useEffect, useRef, useState } from "react";
import { ApiError } from "./api";

export type Parsed<T> = { value: T } | { error: string };

/** A spending limit as typed, or why it can't be saved. The alert reserve may be $0. */
export function parseLimit(text: string, reserve = false): Parsed<number> {
  const t = text.trim().replace(/^\$\s*/, "");
  // In cents, as it's shown.
  const n = Math.round(Number(t) * 100) / 100;
  if (!t || !Number.isFinite(n))
    return { error: reserve ? "Give an amount, $0 or more." : "Give an amount." };
  if (reserve ? n < 0 : n <= 0)
    return { error: reserve ? "It can't be below $0." : "A limit must be more than $0." };
  return { value: n };
}

/** A name as typed, or why it can't be saved. */
export const parseName = (text: string): Parsed<string> =>
  text.trim() ? { value: text.trim() } : { error: "Your name can't be empty." };

export function SavedRow<T extends string | number>({
  label,
  saved,
  parse,
  save,
  prefix,
  input,
}: {
  label: string;
  saved: T;
  parse: (text: string) => Parsed<T>;
  /** Rejects with the brain's message. */
  save: (value: T) => Promise<void>;
  prefix?: ReactNode;
  input?: InputHTMLAttributes<HTMLInputElement>;
}) {
  const [text, setText] = useState(String(saved));
  const [error, setError] = useState("");
  const typing = useRef(false);
  // Saved here or elsewhere: shown, unless you're typing in it.
  useEffect(() => {
    if (!typing.current) setText(String(saved));
  }, [saved]);

  const commit = async () => {
    typing.current = false;
    const r = parse(text);
    if ("error" in r) {
      setError(r.error);
      setText(String(saved));
      return;
    }
    setError("");
    setText(String(r.value));
    if (r.value === saved) return;
    try {
      await save(r.value);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save.");
      setText(String(saved));
    }
  };

  return (
    <div className="row">
      <div className="txt">
        <b>{label}</b>
        {error && <span className="form-error">{error}</span>}
      </div>
      {prefix}
      <input
        {...input}
        aria-label={label}
        aria-invalid={error ? true : undefined}
        value={text}
        onChange={(e) => {
          typing.current = true;
          setText(e.target.value);
          setError("");
        }}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
      />
    </div>
  );
}
