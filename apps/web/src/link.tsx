import { navigate } from "./router";

/** A real link: the keyboard reaches it, and Cmd- or middle-click opens it in a new tab. */
export function Link({
  to,
  ...props
}: { to: string } & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href">) {
  return (
    <a
      {...props}
      href={to}
      onClick={(e) => {
        props.onClick?.(e);
        if (
          e.defaultPrevented ||
          e.button !== 0 ||
          e.metaKey ||
          e.ctrlKey ||
          e.shiftKey ||
          e.altKey
        )
          return;
        e.preventDefault();
        navigate(to);
      }}
    />
  );
}
