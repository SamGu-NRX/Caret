import { readFileSync } from "node:fs";
import path from "node:path";
import type { ComputerHistory, EmailThread, Skill, Timetable } from "./types.ts";

// Paths are statically scoped so Vercel's file tracing bundles exactly these folders.
const inputsDir = path.join(process.cwd(), "inputs");
const skillsDir = path.join(process.cwd(), "skills");
const readJson = <T,>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;

export function loadInputs() {
  return {
    skill: readJson<Skill>(path.join(skillsDir, "meeting-scheduler", "skill.json")),
    thread: readJson<EmailThread>(path.join(inputsDir, "email-thread.json")),
    history: readJson<ComputerHistory>(path.join(inputsDir, "computer-history.json")),
    timetable: readJson<Timetable>(path.join(inputsDir, "timetable-basel-zurich.json")),
  };
}
