import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mock the models BEFORE importing the function under test ---
vi.mock("../models/User.js", () => ({
  User: {
    findById: vi.fn(),
    findOne: vi.fn(),
    findByIdAndUpdate: vi.fn(),
  },
}));

vi.mock("../models/Commission.js", () => ({
  Commission: {
    create: vi.fn(),
  },
}));

import { distributeCommissions } from "./distributeCommissions.js";
import { User } from "../models/User.js";
import { Commission } from "../models/Commission.js";

// Helper to build a fake affiliate
const affiliate = (overrides: Record<string, any>) => ({
  _id: { toString: () => overrides.id ?? "fake-id" },
  subscription: "active",
  referredBy: null,
  referralCode: "",
  ...overrides,
});

describe("distributeCommissions", () => {
  beforeEach(() => {
    vi.clearAllMocks(); // reset call history between tests
  });

  it("does nothing if the subscriber has no referrer", async () => {
    (User.findById as any).mockResolvedValue({ referredBy: null });

    await distributeCommissions("sub-1", 5000);

    expect(Commission.create).not.toHaveBeenCalled();
  });

  it("pays level 1 affiliate 65% of the amount", async () => {
    // subscriber was referred by code "REF-A"
    (User.findById as any).mockResolvedValue({ referredBy: "REF-A" });
    // the level-1 affiliate, active, top of the chain
    (User.findOne as any).mockResolvedValueOnce(
      affiliate({
        id: "aff-1",
        subscription: "active",
        referredBy: null,
        referralCode: "REF-A",
      }),
    );

    await distributeCommissions("sub-1", 5000);

    expect(Commission.create).toHaveBeenCalledTimes(1);
    expect(Commission.create).toHaveBeenCalledWith(
      expect.objectContaining({
        beneficiary: "aff-1",
        level: 1,
        amount: 3250, // 5000 * 0.65
        status: "pending",
      }),
    );
  });

  it("skips an inactive affiliate but still pays the one above them", async () => {
    (User.findById as any).mockResolvedValue({ referredBy: "REF-A" });
    (User.findOne as any)
      // level 1: inactive — should be skipped, no commission
      .mockResolvedValueOnce(
        affiliate({
          id: "aff-1",
          subscription: "inactive",
          referredBy: "REF-B",
          referralCode: "REF-A",
        }),
      )
      // level 2: active — should be paid at level 2 rate
      .mockResolvedValueOnce(
        affiliate({
          id: "aff-2",
          subscription: "active",
          referredBy: null,
          referralCode: "REF-B",
        }),
      );

    await distributeCommissions("sub-1", 5000);

    // only the active one got a commission
    expect(Commission.create).toHaveBeenCalledTimes(1);
    expect(Commission.create).toHaveBeenCalledWith(
      expect.objectContaining({ beneficiary: "aff-2", level: 2, amount: 750 }), // 5000 * 0.15
    );
  });

  it("increments referral count only for the level-1 affiliate", async () => {
    (User.findById as any).mockResolvedValue({ referredBy: "REF-A" });
    (User.findOne as any).mockResolvedValueOnce(
      affiliate({
        id: "aff-1",
        subscription: "active",
        referredBy: null,
        referralCode: "REF-A",
      }),
    );

    await distributeCommissions("sub-1", 5000);

    expect(User.findByIdAndUpdate).toHaveBeenCalledWith(expect.anything(), {
      $inc: { referrals: 1 },
    });
  });
});
