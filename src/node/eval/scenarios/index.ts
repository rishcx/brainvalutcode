// All 86 scenarios (PLAN_V3 C.3). Updated as each category file lands.
import { CHANNELS } from "./channels.ts";
import { EVIDENCE } from "./evidence.ts";
import { HINGLISH } from "./hinglish.ts";
import { INJECTION } from "./injection.ts";
import { READ } from "./read.ts";
import { REMINDERS } from "./reminders.ts";
import { TASKS } from "./tasks.ts";
import { TIME } from "./time.ts";
import { UNSUPPORTED } from "./unsupported.ts";
import type { Scenario } from "../types.ts";

export const ALL: Scenario[] = [
  ...EVIDENCE,
  ...REMINDERS,
  ...TASKS,
  ...READ,
  ...HINGLISH,
  ...UNSUPPORTED,
  ...INJECTION,
  ...CHANNELS,
  ...TIME,
];
