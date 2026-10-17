import { API_PREFIX, type Attachment } from "@hatbot/shared";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The whole answer, for errors that say more, like a 409's current version. */
    readonly data: unknown = null,
  ) {
    super(message);
  }
}

/**
 * What went wrong, in a sentence for the page: the brain's own words, or `fallback` when it didn't
 * answer.
 */
export const errorText = (err: unknown, fallback = "Couldn't reach Hatbot.") =>
  err instanceof ApiError ? err.message : fallback;

/** JSON request to the brain. Session cookie auth; 401 sends the app back to the login screen. */
export async function api<T>(
  path: string,
  /** `timeout`: in ms, after which it gives up and throws. */
  init: { method?: string; body?: unknown; timeout?: number } = {},
): Promise<T> {
  const res = await fetch(API_PREFIX + path, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: init.body === undefined ? {} : { "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    credentials: "same-origin",
    signal: init.timeout ? AbortSignal.timeout(init.timeout) : undefined,
  });
  // 204: nothing to answer, e.g. no tidy-up to propose.
  const data = res.status === 204 ? null : await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith("/auth/"))
      window.dispatchEvent(new Event("hatbot:unauthorized"));
    throw new ApiError(
      res.status,
      (data as { error?: string } | null)?.error ?? `HTTP ${res.status}`,
      data,
    );
  }
  return data as T;
}

/**
 * Uploads a file for your next message. XMLHttpRequest rather than fetch, which can't tell how much has
 * been sent: `progress` hears that, from 0 to 1.
 */
export function upload(
  file: File,
  signal?: AbortSignal,
  progress?: (sent: number) => void,
): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_PREFIX}/attachments`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total) progress?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      let data: unknown = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300) return resolve(data as Attachment);
      if (xhr.status === 401) window.dispatchEvent(new Event("hatbot:unauthorized"));
      reject(new ApiError(xhr.status, (data as { error?: string }).error ?? `HTTP ${xhr.status}`));
    };
    xhr.onerror = () => reject(new TypeError("Couldn't reach Hatbot."));
    xhr.onabort = () => reject(new DOMException("Stopped.", "AbortError"));
    signal?.addEventListener("abort", () => xhr.abort());
    const form = new FormData();
    form.append("file", file);
    xhr.send(form);
  });
}

/** Where an attachment's file is served. */
export const attachmentUrl = (id: number, download = false) =>
  `${API_PREFIX}/attachments/${id}${download ? "?download" : ""}`;
