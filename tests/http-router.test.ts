import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { matchRoute, NativeRouter } from "../lib/http/router.js";

assert.deepEqual(matchRoute("/api/device-actions/:action", "/api/device-actions/set-mode"), {
  action: "set-mode",
});
assert.deepEqual(matchRoute("/api/items/:id", "/api/items/a%20b"), { id: "a b" });
assert.equal(matchRoute("/api/items/:id", "/api/items"), null);
assert.equal(matchRoute("/api/items/:id", "/api/other/1"), null);
assert.equal(matchRoute("/api/items/:id", "/api/items/%EF"), null);

const router = new NativeRouter();
let receivedAction: string | null = null;
router.post("/api/device-actions/:action", ({ params }) => {
  receivedAction = params.action ?? null;
});

const request = Object.assign(new EventEmitter(), { method: "POST" });
const response = new EventEmitter();
assert.equal(await router.dispatch(request as any, response as any, new URL("http://localhost/api/device-actions/charge")), true);
assert.equal(receivedAction, "charge");
assert.equal(await router.dispatch(request as any, response as any, new URL("http://localhost/api/status")), false);

const failingRouter = new NativeRouter().get("/failure", () => {
  throw new Error("handler failure");
});
await assert.rejects(
  failingRouter.dispatch(Object.assign(new EventEmitter(), { method: "GET" }) as any, response as any, new URL("http://localhost/failure")),
  /handler failure/,
);

console.log("HTTP router tests passed");
