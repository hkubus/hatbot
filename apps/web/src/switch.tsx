import { useId, useLayoutEffect, useRef, useState } from "react";

/**
 * An on/off switch. Screen readers hear it as a switch named by its row's label (a settings row's
 * title or a form row's label), found in the page around it; `label` names it where there's none.
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
    const el = ref.current
      ?.closest(".row, .form-row")
      ?.querySelector<HTMLElement>(".txt b, .label");
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
      aria-label={label ?? (labelledBy ? undefined : "On")}
      onClick={() => onChange(!on)}
    />
  );
}
