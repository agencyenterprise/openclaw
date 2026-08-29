import type { SessionEntry } from "./types.js";

export function stripSessionEntryRuntimeFields(entry: SessionEntry): SessionEntry {
  const skillsSnapshot = entry.skillsSnapshot;
  if (!skillsSnapshot || !("resolvedSkills" in skillsSnapshot)) {
    return entry;
  }
  delete (skillsSnapshot as { resolvedSkills?: unknown }).resolvedSkills;
  return entry;
}

export function copySessionEntryForPersistence(entry: SessionEntry): SessionEntry {
  const skillsSnapshot = entry.skillsSnapshot;
  if (!skillsSnapshot || !("resolvedSkills" in skillsSnapshot)) {
    return entry;
  }
  const { resolvedSkills: _resolvedSkills, ...persistedSkillsSnapshot } = skillsSnapshot;
  return {
    ...entry,
    skillsSnapshot: persistedSkillsSnapshot,
  };
}
