import type { ContentfulStatusCode } from "hono/utils/http-status";

export class UserError extends Error {
  constructor(
    message: string,
    readonly status: ContentfulStatusCode = 400,
  ) {
    super(message);
  }
}
