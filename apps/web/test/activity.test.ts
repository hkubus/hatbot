import { expect, test } from "bun:test";
import type { TaskStep } from "@hatbot/shared";
import { installDom } from "./dom";

installDom();
const { progressLines, taskLines } = await import("../src/tasks");

const step = (kind: TaskStep["kind"], name: string, detail = ""): TaskStep => ({
  id: 1,
  taskId: 1,
  kind,
  name,
  detail,
  screenshot: null,
  url: null,
  createdAt: "2026-10-23T18:00:00Z",
});

test("a reply's progress shows each line where it last came, and Thinking… only while nothing came of it", () => {
  const progress =
    "\nThinking…\n\nReading memory: homelab.md\n\nThinking…\n\nThe NAS is **nas01**.\n\nReading memory: homelab.md\n";
  expect(progressLines(progress)).toEqual(["The NAS is nas01.", "Reading memory: homelab.md"]);
  expect(progressLines(`${progress}\nThinking…\n`)).toEqual([
    "The NAS is nas01.",
    "Reading memory: homelab.md",
    "Thinking…",
  ]);
});

test("a task's activity is its steps, then what it's doing now unless a step says it already", () => {
  const steps = [
    step("note", "Note", "Checking the disks first.\nThen the logs."),
    step("screenshot", "Screenshot"),
    step("action", "ssh_exec", "On nas: smartctl -a /dev/sda"),
  ];
  expect(taskLines(steps, "Then the logs.")).toEqual([
    "Checking the disks first. Then the logs.",
    "On nas: smartctl -a /dev/sda",
  ]);
  expect(taskLines(steps, "SMART overall: PASSED")).toEqual([
    "Checking the disks first. Then the logs.",
    "On nas: smartctl -a /dev/sda",
    "SMART overall: PASSED",
  ]);
  expect(taskLines([], "Working…")).toEqual(["Working…"]);
  expect(taskLines(steps, "Working…")).toHaveLength(2);
});
