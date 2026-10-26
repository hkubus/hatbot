import { API_PREFIX, chartValue, type ListingsChart, listingPhoto } from "@hatbot/shared";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "../icons";

type Item = ListingsChart["items"][number];

const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

/** A row that scrolls sideways, with buttons to page it for a mouse. */
export function ScrollRow({ count, children }: { count: number; children: ReactNode }) {
  const row = useRef<HTMLDivElement>(null);
  const [ends, setEnds] = useState({ back: false, fwd: false });
  const measure = () => {
    const el = row.current;
    if (!el) return;
    // Rounded: a zoomed page leaves the last scroll position a fraction short.
    const back = el.scrollLeft > 1;
    const fwd = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setEnds((e) => (e.back === back && e.fwd === fwd ? e : { back, fwd }));
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: measured again only as items come in.
  useLayoutEffect(() => {
    measure();
    const el = row.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [count]);
  const page = (step: number) => {
    const el = row.current;
    const card = el?.firstElementChild?.clientWidth ?? 180;
    if (el) el.scrollBy({ left: step * Math.max(el.clientWidth - card, card), behavior: "smooth" });
  };
  return (
    <div className="listings-frame">
      <div className="listings-row" ref={row} onScroll={measure}>
        {children}
      </div>
      {ends.back && (
        <button
          type="button"
          className="listings-page back"
          title="Back"
          tabIndex={-1}
          onClick={() => page(-1)}
        >
          <Icon name="chevron" />
        </button>
      )}
      {ends.fwd && (
        <button
          type="button"
          className="listings-page"
          title="More"
          tabIndex={-1}
          onClick={() => page(1)}
        >
          <Icon name="chevron" />
        </button>
      )}
    </div>
  );
}

export function ListingsRow({ spec }: { spec: ListingsChart }) {
  return (
    <figure className="reply-listings">
      {spec.title && <figcaption className="chart-title">{spec.title}</figcaption>}
      <ScrollRow count={spec.items.length}>
        {spec.items.map((it, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: items are positional
          <Listing key={i} item={it} unit={spec.unit} />
        ))}
      </ScrollRow>
    </figure>
  );
}

function Listing({ item, unit }: { item: Item; unit?: string }) {
  const where = [item.site || host(item.url), item.note].filter(Boolean).join(" · ");
  return (
    <a className="listing" href={item.url} target="_blank" rel="noreferrer noopener">
      <Photo url={item.photo} />
      <span className="listing-title">{item.title}</span>
      {item.price !== undefined && (
        <span className="listing-price">{chartValue(item.price, unit)}</span>
      )}
      {where && <span className="listing-where">{where}</span>}
    </a>
  );
}

/** A listing's photo through the brain, or an empty tile for one it won't fetch or that failed. */
export function Photo({ url }: { url?: string }) {
  const [broken, setBroken] = useState(false);
  const shown = url && listingPhoto(url) && !broken;
  return (
    <div className="listing-photo">
      {shown && (
        <img
          src={`${API_PREFIX}/listing-photo?url=${encodeURIComponent(url)}`}
          alt=""
          loading="lazy"
          onError={() => setBroken(true)}
        />
      )}
    </div>
  );
}
