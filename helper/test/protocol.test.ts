import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AnyMessage, ConsumerMessage, HelperMessage, Node, ReaderMessage } from "../src/protocol.ts";
import { renderProtocolJsonSchema, SCHEMA_PATH } from "../src/export-schema.ts";

const GOLDEN = fileURLToPath(new URL("../fixtures/golden/protocol.ndjson", import.meta.url));
const lines = readFileSync(GOLDEN, "utf8").trim().split("\n");

describe("golden protocol fixture", () => {
  it("holds one of every message type", () => {
    const types = lines.map((l) => (JSON.parse(l) as { type: string }).type);
    expect(types).toEqual(["hello", "snapshot", "focus", "appSwitch", "windowClosed", "pasteboard", "fillRequest", "fillProposal", "error"]);
  });

  it("parses every line, and each parse is lossless", () => {
    for (const l of lines) {
      const json: unknown = JSON.parse(l);
      const parsed = AnyMessage.parse(json);
      expect(parsed).toEqual(json);
    }
  });

  it("routes each line to the union for its direction", () => {
    const [hello, snapshot, focus, appSwitch, closed, pasteboard, fillRequest, proposal, error] = lines.map((l) => JSON.parse(l) as unknown);
    for (const m of [hello, snapshot, focus, appSwitch, closed, pasteboard]) expect(ReaderMessage.safeParse(m).success).toBe(true);
    expect(ConsumerMessage.safeParse(fillRequest).success).toBe(true);
    expect(ConsumerMessage.safeParse(hello).success).toBe(true);
    for (const m of [proposal, error]) expect(HelperMessage.safeParse(m).success).toBe(true);
    expect(ReaderMessage.safeParse(proposal).success).toBe(false);
  });

  it("rejects the shapes the Swift decoder also rejects", () => {
    const base = { key: "k", parent: null, role: "AXButton" };
    expect(Node.safeParse(base).success).toBe(true);
    expect(Node.safeParse({ key: "k", role: "AXButton" }).success).toBe(false);
    expect(Node.safeParse({ ...base, editable: null }).success).toBe(false);
    expect(Node.safeParse({ ...base, editable: false }).success).toBe(false);
    expect(Node.safeParse({ ...base, label: null }).success).toBe(false);
  });

  it("rejects a snapshot with an unknown state and an unversioned message", () => {
    const snapshot = JSON.parse(lines[1] ?? "") as { nodes: { states?: string[] }[]; v?: number };
    const bad = structuredClone(snapshot);
    bad.nodes[0] = { ...bad.nodes[0], states: ["hovered"] };
    expect(ReaderMessage.safeParse(bad).success).toBe(false);
    const unversioned = structuredClone(snapshot);
    delete unversioned.v;
    expect(ReaderMessage.safeParse(unversioned).success).toBe(false);
  });
});

describe("exported JSON Schema", () => {
  it("matches the zod schemas (run `pnpm schema` after editing protocol.ts)", () => {
    expect(readFileSync(SCHEMA_PATH, "utf8")).toBe(renderProtocolJsonSchema());
  });
});
