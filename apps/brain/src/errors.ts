import type { ContentfulStatusCode } from "hono/utils/http-status";

/** Something the owner asked for that can't be done: the message is for them, `status` the answer's. */
export class UserError extends Error {
  constructor(
    message: string,
    readonly status: ContentfulStatusCode = 400,
  ) {
    super(message);
  }
}
