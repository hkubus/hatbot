import { API_PREFIX, chartValue, type ListingsChart, listingPhoto } from "@hatbot/shared";
import { useLayoutEffect, useRef, useState } from "react";
import { Icon } from "../icons";

type Item = ListingsChart["items"][number];

const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

export function ListingsRow({ spec }: { spec: ListingsChart }) {
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
  }, [spec.items.length]);
  const page = (step: number) => {
    const el = row.current;
    if (el) el.scrollBy({ left: step * Math.max(el.clientWidth - 180, 180), behavior: "smooth" });
  };
  return (
    <figure className="reply-listings">
      {spec.title && <figcaption className="chart-title">{spec.title}</figcaption>}
      <div className="listings-frame">
        <div className="listings-row" ref={row} onScroll={measure}>
          {spec.items.map((it, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: items are positional
            <Listing key={i} item={it} unit={spec.unit} />
          ))}
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
    </figure>
  );
}

function Listing({ item, unit }: { item: Item; unit?: string }) {
  const [broken, setBroken] = useState(false);
  const photo = item.photo && listingPhoto(item.photo) && !broken ? item.photo : null;
  const where = [item.site || host(item.url), item.note].filter(Boolean).join(" · ");
  return (
    <a className="listing" href={item.url} target="_blank" rel="noreferrer noopener">
      <div className="listing-photo">
        {photo && (
          <img
            src={`${API_PREFIX}/listing-photo?url=${encodeURIComponent(photo)}`}
            alt=""
            loading="lazy"
            onError={() => setBroken(true)}
          />
        )}
      </div>
      <span className="listing-title">{item.title}</span>
      {item.price !== undefined && (
        <span className="listing-price">{chartValue(item.price, unit)}</span>
      )}
      {where && <span className="listing-where">{where}</span>}
    </a>
  );
}
