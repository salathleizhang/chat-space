import { expect, test } from "bun:test";
import { confirmBlenderRequest } from "./outbox";

test("a success HTTP status without the matching durable acknowledgement cannot clear a billed intent", () => {
  const id = "00000000-0000-4000-8000-000000000001", batch = "00000000-0000-4000-8000-000000000002";
  const request = { version: 1 as const, path: "batches", body: { id: batch, items: [{ id: "a" }] } };
  expect(() => confirmBlenderRequest(request, "alice", "project", {})).toThrow();
  expect(() => confirmBlenderRequest(request, "alice", "project", null)).toThrow();
  expect(() => confirmBlenderRequest(request, "alice", "project", { batchId: batch, sessions: [] })).toThrow();
  const result = { batchId: batch, sessions: [{ id, project: "project", owner: "alice", batchId: batch }] };
  expect(() => confirmBlenderRequest(request, "alice", "project", result)).not.toThrow();
  expect(() => confirmBlenderRequest(request, "bob", "project", result)).toThrow();
  expect(() => confirmBlenderRequest(request, "alice", "other-project", result)).toThrow();
});
