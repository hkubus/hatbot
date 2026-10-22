import { useId, useLayoutEffect, useRef, useState } from "react";

/**
 * Screen readers name it by its row's label (a settings row's title, a form row's label, or the
 * text it starts with); `label` names it where there's none.
 */
export function Switch({
  on,
  onChange,
  label,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
  label?: string;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const id = useId();
  const [labelledBy, setLabelledBy] = useState<string | undefined>();
  useLayoutEffect(() => {
    if (label) return;
    const row = ref.current?.closest(".row, .form-row");
    const el =
      row?.querySelector<HTMLElement>(".txt b, .label") ??
      row?.querySelector<HTMLElement>(":scope > span:first-child");
    if (!el) return;
    if (!el.id) el.id = `${id}label`;
    setLabelledBy(el.id);
  }, [label, id]);
  return (
    <button
      ref={ref}
      type="button"
      role="switch"
      className={`switch ${on ? "on" : ""}`}
      aria-checked={on}
      aria-labelledby={label ? undefined : labelledBy}
      aria-label={label}
      onClick={() => onChange(!on)}
    />
  );
}
