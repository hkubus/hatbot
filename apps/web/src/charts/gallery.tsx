import type { GalleryChart } from "@hatbot/shared";
import { Photo, ScrollRow } from "./listings";

export function GalleryRow({ spec }: { spec: GalleryChart }) {
  return (
    <figure className="reply-listings">
      {spec.title && <figcaption className="chart-title">{spec.title}</figcaption>}
      <ScrollRow count={spec.photos.length}>
        {spec.photos.map((url, i) =>
          spec.url ? (
            <a
              // biome-ignore lint/suspicious/noArrayIndexKey: photos are positional
              key={i}
              className="gallery-photo"
              href={spec.url}
              target="_blank"
              rel="noreferrer noopener"
            >
              <Photo url={url} />
            </a>
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: photos are positional
            <div key={i} className="gallery-photo">
              <Photo url={url} />
            </div>
          ),
        )}
      </ScrollRow>
    </figure>
  );
}
