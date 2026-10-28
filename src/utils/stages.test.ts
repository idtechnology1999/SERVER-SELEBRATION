import { describe, it, expect } from "vitest";
import { accessibleStages, addOneMonth, isPaidUp, stagesUpTo } from "./stages.js";

const DAY = 24 * 60 * 60 * 1000;
const now = new Date("2026-11-15T12:00:00Z");

describe("stage access", () => {
  it("buying a higher stage unlocks every stage below it", () => {
    expect(stagesUpTo(3)).toEqual(["fish", "dolphin", "shark"]);
    expect(accessibleStages({ stage: 4, subscription: "active", paidUntil: new Date(now.getTime() + 10 * DAY) }, now, 3))
      .toEqual(["fish", "dolphin", "shark", "whale"]);
  });

  it("keeps access during the grace period, then locks everything", () => {
    const user = { stage: 2, subscription: "active", paidUntil: new Date(now.getTime() - 2 * DAY) };
    expect(isPaidUp(user, now, 3)).toBe(true);
    expect(accessibleStages(user, now, 3)).toEqual(["fish", "dolphin"]);
    expect(isPaidUp(user, now, 1)).toBe(false);
    expect(accessibleStages(user, now, 1)).toEqual([]);
  });

  it("an active free trial gives Fish only", () => {
    const trial = { stage: 0, subscription: "trial", trialEndsAt: new Date(now.getTime() + DAY) };
    expect(accessibleStages(trial, now, 3)).toEqual(["fish"]);
  });

  it("a cancelled subscription has no access even before its paid date", () => {
    expect(accessibleStages({ stage: 3, subscription: "cancelled", paidUntil: new Date(now.getTime() + 10 * DAY) }, now, 3)).toEqual([]);
  });

  it("an account that never paid and has no trial gets nothing", () => {
    expect(accessibleStages({ stage: 0, subscription: "expired" }, now, 3)).toEqual([]);
  });

  it("adds one calendar month", () => {
    expect(addOneMonth(new Date("2026-01-10T00:00:00Z")).toISOString()).toBe("2026-02-10T00:00:00.000Z");
  });
});
