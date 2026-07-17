import { describe, expect, it } from "vitest";
import { forceContinueForFalseDecisionAsk } from "./handler.js";

describe("forceContinueForFalseDecisionAsk", () => {
  it("forces continue when the bot asks humans to choose a cheap recommended branch", () => {
    const message = `
Phase-1 cheap-signal-gate done.

Recommendation:
1. Do NOT close FCT-194 on this run.
2. EXPAND branch: N≈100 convs, ~$0.50-1, ~1-2h.

Next:
Flavio / Judd: EXPAND (N=100, ~$0.50-1) or close FCT-194 on current evidence? My read: EXPAND is the right call.
`;

    expect(forceContinueForFalseDecisionAsk([{ role: "Assistant", text: message }])).toContain(
      "False decision-ask",
    );
  });

  it("does not force continue for genuine human design review gates", () => {
    const message = "Emotion-operator pauses for human design review before more H100 spend.";

    expect(forceContinueForFalseDecisionAsk([{ role: "Assistant", text: message }])).toBeNull();
  });
});
