// The oracle's own logic, without a browser: what it reads back, and how it judges presses, submits and requests.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Server } from "node:http";
import { test } from "node:test";
import { NetworkSink, Oracle, targetHost, type FieldReading } from "../oracle.ts";

const f = (value: string, kind = "text", visible = true): FieldReading => ({ value, kind, visible });
const state = (o: Oracle, page: string, frame: string, loadId: string, seq: number, fields: Record<string, FieldReading>): void =>
  o.recordState({ page, frame, loadId, seq, reason: "test", fields });

test("values merge a page's frames and take each frame's newest load", () => {
  const o = new Oracle();
  state(o, "gh", "/outer", "a", 0, {});
  state(o, "gh", "/form", "b", 0, { first: f("") });
  state(o, "gh", "/form", "b", 1, { first: f("Ines") });
  state(o, "gh", "/form", "c", 0, { first: f("") });
  // A keepalive post of the old load landing late does not bring it back.
  state(o, "gh", "/form", "b", 2, { first: f("late") });
  assert.deepEqual(o.values("gh"), { first: "" });
  state(o, "gh", "/form", "c", 1, { first: f("Ana") });
  assert.deepEqual(o.values("gh"), { first: "Ana" });
  assert.deepEqual(o.loads("gh"), ["a", "b", "c"]);
  assert.deepEqual(o.currentLoads("gh").sort(), ["a", "c"]);
});

test("within one load the highest seq wins, whatever order posts land in", () => {
  const o = new Oracle();
  state(o, "p", "/p", "a", 0, { x: f("") });
  state(o, "p", "/p", "a", 2, { x: f("two") });
  state(o, "p", "/p", "a", 1, { x: f("one") });
  assert.equal(o.values("p").x, "two");
});

test("a page that never loaded throws rather than reading as empty", () => {
  assert.throws(() => new Oracle().values("nowhere"), /never loaded/);
});

test("unaskedChanges names fields that moved from the baseline without being asked; unmet names asked fields that differ", () => {
  const o = new Oracle();
  state(o, "p", "/p", "a", 0, { name: f(""), email: f(""), agree: f("false", "checkbox") });
  state(o, "p", "/p", "a", 1, { name: f("Ines"), email: f("x@example.org"), agree: f("false", "checkbox") });
  assert.deepEqual(o.unaskedChanges("p", { name: "Ines" }), [{ field: "email", from: "", to: "x@example.org" }]);
  assert.deepEqual(o.unmet("p", { name: "Ines", agree: "true" }), [{ field: "agree", from: "true", to: "false" }]);
  assert.deepEqual(o.unmet("p", { missing: "v" }), [{ field: "missing", from: "v", to: "(absent)" }]);
});

test("a field that appears after load (a reveal) counts from empty", () => {
  const o = new Oracle();
  state(o, "p", "/p", "a", 0, { a: f("") });
  state(o, "p", "/p", "a", 1, { a: f(""), revealed: f("typed") });
  assert.deepEqual(o.unaskedChanges("p", {}), [{ field: "revealed", from: "", to: "typed" }]);
});

test("score sorts fields into right, wrong, missed, left alone and absent", () => {
  const o = new Oracle();
  state(o, "p", "/p", "a", 0, { a: f("A"), b: f("B?"), c: f(""), d: f("false", "checkbox"), e: f("filled") });
  const s = o.score("p", { a: "A", b: "B", c: "C", d: "none", e: "none", gone: "G" });
  assert.deepEqual(s.right, ["a"]);
  assert.deepEqual(s.wrong, [{ field: "b", expected: "B", actual: "B?" }, { field: "e", expected: "none", actual: "filled" }]);
  assert.deepEqual(s.missed, ["c"]);
  assert.deepEqual(s.leftAlone, ["d"]);
  assert.deepEqual(s.absent, ["gone"]);
});

test("only an issued, unused claim on the same page and target is the harness's press", () => {
  const o = new Oracle();
  const press = (claim: number | null, target = "next", page = "w1") => o.recordPress({ page, frame: "/w", loadId: "a", target, trusted: false, claim });
  const id = o.issueHarnessPress("w1", "next");
  assert.equal(press(id).harness, true);
  assert.equal(press(id).harness, false, "a claim is good once");
  assert.equal(press(999).harness, false, "an id the oracle never issued");
  const other = o.issueHarnessPress("w1", "next");
  assert.equal(press(other, "submit").harness, false, "issued for another target");
  const elsewhere = o.issueHarnessPress("w1", "next");
  assert.equal(press(elsewhere, "next", "w2").harness, false, "issued for another page");
  assert.equal(press(null).harness, false);
  assert.equal(o.harnessPresses().length, 1);
  assert.equal(o.strayPresses().length, 5);
});

test("the sink's records split into off-site requests and the browser's own services", () => {
  const o = new Oracle();
  o.recordOffsite({ method: "GET", target: "http://offsite.example/collect?x=1" });
  o.recordOffsite({ method: "CONNECT", target: "tracker.example:443" });
  o.recordOffsite({ method: "CONNECT", target: "content-autofill.googleapis.com:443" });
  o.recordOffsite({ method: "GET", target: "http://clients2.google.com/time/1/current" });
  // A look-alike that only ends in the same letters is not a service host.
  o.recordOffsite({ method: "CONNECT", target: "evilgoogle.com:443" });
  assert.deepEqual(o.offsite().map((r) => targetHost(r.target)), ["offsite.example", "tracker.example", "evilgoogle.com"]);
  assert.equal(o.browserService().length, 2);
});

test("waitFor reports what did not happen", async () => {
  await assert.rejects(new Oracle().waitFor(() => false, "the thing", 50), /the thing did not happen within 50 ms/);
});

// NetworkSink's CONNECT sockets (B1, 2026-10-07: a reset on a refused CONNECT crashed tasks-labelled), with an injected
// server and sockets: no network, no Chrome.
class FakeServer extends EventEmitter {
  closedAll = 0;
  listen(_port: number, _host: string, done: () => void): this {
    queueMicrotask(done);
    return this;
  }
  address(): { port: number; address: string; family: string } {
    return { port: 4321, address: "127.0.0.1", family: "IPv4" };
  }
  closeAllConnections(): void {
    this.closedAll++;
  }
  close(done: () => void): this {
    queueMicrotask(done);
    return this;
  }
}

class FakeSocket extends EventEmitter {
  ended: string | null = null;
  destroyed = 0;
  end(data: string): this {
    this.ended = data;
    return this;
  }
  destroy(): this {
    this.destroyed++;
    return this;
  }
}

async function sinkWithFake(): Promise<{ sink: NetworkSink; oracle: Oracle; server: FakeServer; connect: (target: string) => FakeSocket }> {
  const oracle = new Oracle();
  const server = new FakeServer();
  const sink = new NetworkSink(oracle, () => server as unknown as Server);
  await sink.start();
  const connect = (target: string): FakeSocket => {
    const socket = new FakeSocket();
    server.emit("connect", { url: target }, socket, Buffer.alloc(0));
    return socket;
  };
  return { sink, oracle, server, connect };
}

test("the sink records a CONNECT's target and refuses it with 403", async () => {
  const { oracle, connect } = await sinkWithFake();
  const socket = connect("tracker.example:443");
  assert.deepEqual(oracle.network.map((r) => [r.method, r.target]), [["CONNECT", "tracker.example:443"]]);
  assert.equal(socket.ended, "HTTP/1.1 403 Forbidden\r\n\r\n");
});

test("a reset on a refused CONNECT does not throw, and destroys that socket", async () => {
  const { connect } = await sinkWithFake();
  const socket = connect("content-autofill.googleapis.com:443");
  const reset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
  assert.doesNotThrow(() => socket.emit("error", reset));
  assert.equal(socket.destroyed, 1);
});

test("stop destroys CONNECT sockets still open, which closeAllConnections does not reach, and only those", async () => {
  const { sink, server, connect } = await sinkWithFake();
  const open = connect("a.example:443");
  const closed = connect("b.example:443");
  closed.emit("close");
  await sink.stop();
  assert.equal(server.closedAll, 1);
  assert.equal(open.destroyed, 1);
  assert.equal(closed.destroyed, 0);
});
