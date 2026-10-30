import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../models/Commission.js", () => ({ Commission: { find: vi.fn(), updateMany: vi.fn() } }));
vi.mock("../models/Withdrawal.js", () => ({ Withdrawal: { find: vi.fn() } }));
vi.mock("../models/Settings.js", () => ({ Settings: { findOne: vi.fn() } }));

import { balanceFor, lastPayoutRelease, nextPayoutRelease } from "./payouts.js";
import { Commission } from "../models/Commission.js";
import { Withdrawal } from "../models/Withdrawal.js";

const selectResolving = (rows: any[]) => ({ select: vi.fn().mockResolvedValue(rows) });

describe("weekly payout timing (Thursday 10pm Nigeria = 21:00 UTC)", () => {
  it("from a Monday, the next release is that Thursday 10pm", () => {
    // Mon 26 Oct 2026, 12:00 UTC
    expect(nextPayoutRelease(new Date("2026-10-26T12:00:00Z")).toISOString()).toBe("2026-10-29T21:00:00.000Z");
  });

  it("on Thursday before 10pm it's the same evening; after 10pm it's next week", () => {
    expect(nextPayoutRelease(new Date("2026-10-29T20:59:00Z")).toISOString()).toBe("2026-10-29T21:00:00.000Z");
    expect(nextPayoutRelease(new Date("2026-10-29T21:30:00Z")).toISOString()).toBe("2026-11-05T21:00:00.000Z");
  });

  it("the last release is the previous Thursday 10pm", () => {
    expect(lastPayoutRelease(new Date("2026-10-30T09:00:00Z")).toISOString()).toBe("2026-10-29T21:00:00.000Z");
  });
});

describe("balance", () => {
  beforeEach(() => vi.clearAllMocks());

  it("a partial withdrawal only takes the requested amount", async () => {
    (Commission.find as any).mockReturnValue(selectResolving([
      { amount: 30000, status: "withdrawable" },
      { amount: 5000, status: "pending" },
    ]));
    (Withdrawal.find as any).mockReturnValue(selectResolving([{ amount: 12000, status: "approved" }]));

    const b = await balanceFor("u1", new Date("2026-10-30T09:00:00Z"));

    expect(b).toMatchObject({ totalEarned: 35000, pending: 5000, available: 18000, withdrawn: 12000, inWithdrawal: 0 });
  });

  it("a request waiting for approval is held back from the available balance", async () => {
    (Commission.find as any).mockReturnValue(selectResolving([{ amount: 20000, status: "withdrawable" }]));
    (Withdrawal.find as any).mockReturnValue(selectResolving([{ amount: 15000, status: "pending" }]));

    const b = await balanceFor("u1");

    expect(b.available).toBe(5000);
    expect(b.inWithdrawal).toBe(15000);
  });
});
