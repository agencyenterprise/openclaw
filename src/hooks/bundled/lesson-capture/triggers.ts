// Heuristic triggers that mark a turn as lesson evidence. No model is involved.
export type LessonTriggerConfig = {
  resultTriggers: string[];
  correctionTriggers: string[];
};

export const DEFAULT_LESSON_TRIGGERS: LessonTriggerConfig = {
  resultTriggers: ["\\bresults?\\b", "\\bverdict\\b", "CLOSED", "Correction:"],
  correctionTriggers: [
    "Correction:",
    "\\bwrong\\b",
    "\\bincorrect\\b",
    "should never",
    "not what I asked",
    "that's not",
    "you (?:said|claimed|reported)",
    "^no[,.]",
  ],
};

export type CompiledTrigger = {
  name: string;
  pattern: RegExp;
};

function compileTrigger(prefix: string, source: string): CompiledTrigger {
  const caseSensitive = /[A-Z]/.test(source);
  try {
    return { name: `${prefix}:${source}`, pattern: new RegExp(source, caseSensitive ? "" : "i") };
  } catch (err) {
    throw new Error(`lesson-capture: invalid ${prefix} trigger ${JSON.stringify(source)}`, {
      cause: err,
    });
  }
}

export type CompiledLessonTriggers = {
  result: CompiledTrigger[];
  correction: CompiledTrigger[];
};

export function compileLessonTriggers(config: LessonTriggerConfig): CompiledLessonTriggers {
  return {
    result: config.resultTriggers.map((source) => compileTrigger("assistant", source)),
    correction: config.correctionTriggers.map((source) => compileTrigger("human", source)),
  };
}

export function findTrigger(
  triggers: CompiledTrigger[],
  text: string | undefined,
): string | undefined {
  if (!text) {
    return undefined;
  }
  return triggers.find((trigger) => trigger.pattern.test(text))?.name;
}
