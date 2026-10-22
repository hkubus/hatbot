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

const REACH = "Couldn't reach Hatbot.";

/** The fallback is for anything but a lost connection, which always says so. */
export const errorText = (err: unknown, fallback = REACH) =>
  err instanceof ApiError
    ? err.message
    : err instanceof TypeError || (err instanceof DOMException && err.name === "TimeoutError")
      ? REACH
      : fallback;

/** 401 sends the app back to the login screen. */
export async function api<T>(
  path: string,
  /** In ms. */
  init: { method?: string; body?: unknown; timeout?: number } = {},
): Promise<T> {
  const res = await fetch(API_PREFIX + path, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: init.body === undefined ? {} : { "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    credentials: "same-origin",
    signal: init.timeout ? AbortSignal.timeout(init.timeout) : undefined,
  });
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

/** XMLHttpRequest rather than fetch, which can't report upload progress. */
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
    xhr.onerror = () => reject(new TypeError(REACH));
    xhr.onabort = () => reject(new DOMException("Stopped.", "AbortError"));
    signal?.addEventListener("abort", () => xhr.abort());
    const form = new FormData();
    form.append("file", file);
    xhr.send(form);
  });
}

export const attachmentUrl = (id: number, download = false) =>
  `${API_PREFIX}/attachments/${id}${download ? "?download" : ""}`;
