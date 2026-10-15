import { API_PREFIX, type Attachment } from "@hatbot/shared";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** JSON request to the brain. Session cookie auth; 401 sends the app back to the login screen. */
export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(API_PREFIX + path, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: init.body === undefined ? {} : { "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    credentials: "same-origin",
  });
  // 204: nothing to answer, e.g. no tidy-up to propose.
  const data = res.status === 204 ? null : await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith("/auth/"))
      window.dispatchEvent(new Event("hatbot:unauthorized"));
    throw new ApiError(
      res.status,
      (data as { error?: string } | null)?.error ?? `HTTP ${res.status}`,
    );
  }
  return data as T;
}

/** Uploads a file for your next message. */
export async function upload(file: File): Promise<Attachment> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${API_PREFIX}/attachments`, {
    method: "POST",
    body: form,
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new ApiError(res.status, (data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as Attachment;
}

/** Where an attachment's file is served. */
export const attachmentUrl = (id: number, download = false) =>
  `${API_PREFIX}/attachments/${id}${download ? "?download" : ""}`;
