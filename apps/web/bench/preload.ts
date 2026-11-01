// Outside `bun test` there's no runner for test/dom.ts's afterAll to register with. Nothing else in
// bun:test is touched.
import { mock } from "bun:test";

mock.module("bun:test", () => ({ afterAll() {} }));
