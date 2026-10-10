export function Switch({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button
      type="button"
      className={`switch ${on ? "on" : ""}`}
      aria-label={on ? "Turn off" : "Turn on"}
      aria-pressed={on}
      onClick={() => onChange(!on)}
    />
  );
}
