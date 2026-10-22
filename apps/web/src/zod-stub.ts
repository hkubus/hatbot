// Stands in for zod in the web build (vite.config.ts): @hatbot/shared builds its request schemas at
// module top level, and the web never checks a request. Using one throws rather than passing.
const fail = () => {
  throw new Error("zod isn't in the web build; check by hand (see chartspec.ts)");
};
const nothing: unknown = new Proxy(() => {}, {
  get: (_, key) =>
    key === "parse" || key === "safeParse" || key === "parseAsync" ? fail : nothing,
  apply: () => nothing,
});
export const z = nothing;
export default nothing;
