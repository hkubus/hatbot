import { type ReactNode, useRef, useState } from "react";
import { Icon } from "./icons";

/** Without a secure origin there's no clipboard: what's shown is selected to copy by hand. */
export function useCopy(): [boolean, (text: string, shown?: HTMLElement | null) => void] {
  const [copied, setCopied] = useState(false);
  const copy = (text: string, shown?: HTMLElement | null) => {
    const select = () => shown && getSelection()?.selectAllChildren(shown);
    if (!navigator.clipboard) return void select();
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }, select);
  };
  return [copied, copy];
}

export function Copyable({
  value,
  children,
  className,
}: {
  value: string;
  /** What's shown, when it isn't the value as is. */
  children?: ReactNode;
  className?: string;
}) {
  const shown = useRef<HTMLElement>(null);
  const [copied, copy] = useCopy();
  return (
    <div className="copyable">
      <code className={className} ref={shown}>
        {children ?? value}
      </code>
      <button
        type="button"
        className="btn sm ghost"
        title={copied ? "Copied" : "Copy"}
        onClick={() => copy(value, shown.current)}
      >
        <Icon name={copied ? "check" : "copy"} />
      </button>
    </div>
  );
}
