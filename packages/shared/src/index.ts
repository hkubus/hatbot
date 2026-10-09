// API types shared by the brain, the web app and the future iOS app (PLAN.md §4.4).

export const API_PREFIX = "/api/v1";

export type Health = {
  ok: true;
  version: string;
};
