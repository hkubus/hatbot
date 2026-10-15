// Stands in for zod in the web build (vite.config.ts). @hatbot/shared defines its request schemas at
// the top of its modules, which would bring all of zod along; the web never checks a request, so
// here they're built out of nothing. Using one says so rather than passing everything.
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
