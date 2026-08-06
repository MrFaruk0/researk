import { describe, expect, it } from "vitest";
import { listPublicationProfiles, listResearchWorkflows } from "../src/index.js";

describe("research metadata registry", () => {
  it("keeps every initial workflow bounded and non-autonomous", () => {
    const workflows = listResearchWorkflows();
    expect(workflows.map((workflow) => workflow.id)).toEqual([
      "literature-research",
      "scientific-writing-revision",
      "reproduction-planning",
    ]);
    for (const workflow of workflows) {
      expect(workflow.supported).toBe(false);
      expect(workflow.autonomousNetworkAccess).toBe(false);
      expect(workflow.autonomousCodeExecution).toBe(false);
      expect(workflow.limits.maximumModelTurns).toBeGreaterThan(0);
    }
  });

  it("does not claim publication processors exist", () => {
    expect(listPublicationProfiles()).toEqual([
      expect.objectContaining({
        id: "apa-7",
        status: "planned",
        supported: false,
        processor: "unavailable",
      }),
      expect.objectContaining({
        id: "ieee",
        status: "planned",
        supported: false,
        processor: "unavailable",
      }),
    ]);
  });
});
