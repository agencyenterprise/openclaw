import type { SessionEntry } from "./types.js";

const BOOTSTRAP_PROMPT_WARNING_SIGNATURE_HISTORY_MAX = 32;

function normalizeBootstrapPromptWarningSignaturesSeen(
  report: SessionEntry["systemPromptReport"],
): string[] | undefined {
  const truncation = report?.bootstrapTruncation;
  const seen = Array.isArray(truncation?.warningSignaturesSeen)
    ? truncation.warningSignaturesSeen.filter(
        (signature): signature is string =>
          typeof signature === "string" && signature.trim() !== "",
      )
    : [];
  if (seen.length > 0) {
    return [...new Set(seen)].slice(-BOOTSTRAP_PROMPT_WARNING_SIGNATURE_HISTORY_MAX);
  }
  if (truncation?.warningMode === "off") {
    return undefined;
  }
  const signature = truncation?.promptWarningSignature?.trim();
  return signature ? [signature] : undefined;
}

export function stripSessionEntryRuntimeFields(entry: SessionEntry): SessionEntry {
  const systemPromptReport = entry.systemPromptReport;
  let normalized = entry;
  if (systemPromptReport) {
    const warningSignaturesSeen = normalizeBootstrapPromptWarningSignaturesSeen(systemPromptReport);
    const {
      systemPromptReport: _systemPromptReport,
      bootstrapPromptWarningSignaturesSeen: _bootstrapPromptWarningSignaturesSeen,
      ...entryWithoutRuntimeReport
    } = normalized;
    normalized = {
      ...entryWithoutRuntimeReport,
      ...(warningSignaturesSeen
        ? { bootstrapPromptWarningSignaturesSeen: warningSignaturesSeen }
        : {}),
    };
  }
  const skillsSnapshot = entry.skillsSnapshot;
  if (!skillsSnapshot || !("resolvedSkills" in skillsSnapshot)) {
    return normalized;
  }
  const { resolvedSkills: _resolvedSkills, ...persistedSkillsSnapshot } = skillsSnapshot;
  normalized = {
    ...normalized,
    skillsSnapshot: persistedSkillsSnapshot,
  };
  return normalized;
}

export function copySessionEntryForRuntimeCache(entry: SessionEntry): SessionEntry {
  return copySessionEntryForPersistence(entry);
}

export function copySessionEntryForPersistence(entry: SessionEntry): SessionEntry {
  const systemPromptReport = entry.systemPromptReport;
  const warningSignaturesSeen = normalizeBootstrapPromptWarningSignaturesSeen(systemPromptReport);
  const {
    systemPromptReport: _systemPromptReport,
    bootstrapPromptWarningSignaturesSeen: _existingWarningSignaturesSeen,
    ...persistedEntry
  } = entry;
  const entryWithoutRuntimeReport: SessionEntry = {
    ...persistedEntry,
    ...(systemPromptReport
      ? warningSignaturesSeen
        ? { bootstrapPromptWarningSignaturesSeen: warningSignaturesSeen }
        : {}
      : entry.bootstrapPromptWarningSignaturesSeen
        ? { bootstrapPromptWarningSignaturesSeen: entry.bootstrapPromptWarningSignaturesSeen }
        : {}),
  };
  const skillsSnapshot = entry.skillsSnapshot;
  if (!skillsSnapshot || !("resolvedSkills" in skillsSnapshot)) {
    return entryWithoutRuntimeReport;
  }
  const { resolvedSkills: _resolvedSkills, ...persistedSkillsSnapshot } = skillsSnapshot;
  return {
    ...entryWithoutRuntimeReport,
    skillsSnapshot: persistedSkillsSnapshot,
  };
}
