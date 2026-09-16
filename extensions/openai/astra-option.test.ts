import { describe, expect, it } from "vitest";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { resolveModelRoutes } from "./provider-policy-api.js";
import { resolveUnifiedOpenAIThinkingProfile } from "./thinking-policy.js";
import { isStrictAgenticExecutionContractActive } from "../../src/agents/execution-contract.js";

describe("verified Astra option", () => {
  it("registers the exact model without substituting another model or auth route", () => {
    const raw = JSON.stringify(manifest);
    expect(raw).toContain('"id":"gpt-6-astra"');
    const route = resolveModelRoutes({provider:"openai", modelId:"gpt-6-astra", env:{}});
    expect(route).toMatchObject({kind:"routes", routes:[{api:"openai-responses",authRequirement:"api-key"}]});
    if(route.kind === "routes") expect(route.routes).toHaveLength(1);
    expect(resolveModelRoutes({provider:"openai",modelId:"gpt-6-astra-preview",env:{}}).kind).toBe("indeterminate");
  });
  it("activates native completion guards only for exact Astra and honors opt-out", () => {
    for(const modelId of ["gpt-6-astra","openai/gpt-6-astra","openai:gpt-6-astra"]) {
      expect(isStrictAgenticExecutionContractActive({provider:"openai",modelId,config:{}})).toBe(true);
    }
    for(const modelId of ["gpt-6","gpt-6-astra-preview","gpt-6-terra"]) {
      expect(isStrictAgenticExecutionContractActive({provider:"openai",modelId,config:{}})).toBe(false);
    }
    expect(isStrictAgenticExecutionContractActive({provider:"anthropic",modelId:"gpt-6-astra",config:{}})).toBe(false);
    expect(isStrictAgenticExecutionContractActive({provider:"openai",modelId:"gpt-6-astra",config:{agents:{defaults:{embeddedAgent:{executionContract:"default"}}}}})).toBe(false);
  });
  it("offers actual Astra reasoning levels on the preserved OpenClaw runtime", () => {
    const p=resolveUnifiedOpenAIThinkingProfile("gpt-6-astra","openclaw");
    expect(p.defaultLevel).toBe("medium");
    expect(p.levels.map(x=>x.id)).toEqual(["off","minimal","low","medium","high","xhigh","max","ultra"]);
    expect(resolveUnifiedOpenAIThinkingProfile("gpt-6-astra-preview","openclaw").levels.map(x=>x.id)).not.toContain("max");
  });
});
