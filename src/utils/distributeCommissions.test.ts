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

// No admin settings saved → default rates (65/15/5/3/2/1)
vi.mock("../models/Settings.js", () => ({
  Settings: {
    findOne: vi.fn(() => ({ select: vi.fn().mockResolvedValue(null) })),
  },
}));

import { distributeCommissions } from "./distributeCommissions.js";
import { User } from "../models/User.js";
import { Commission } from "../models/Commission.js";
import { Settings } from "../models/Settings.js";

const inTwoWeeks = () => new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
const monthsAgo = (n: number) => new Date(Date.now() - n * 30 * 24 * 60 * 60 * 1000);

// Helper to build a fake affiliate
const affiliate = (overrides: Record<string, any>) => ({
  _id: { toString: () => overrides.id ?? "fake-id" },
  subscription: "active",
  stage: 1,
  paidUntil: inTwoWeeks(),
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

  it("pays on the amount actually paid (₦50,000 upgrade → ₦32,500 at level 1)", async () => {
    (User.findById as any).mockResolvedValue({ referredBy: "REF-A" });
    (User.findOne as any).mockResolvedValueOnce(
      affiliate({ id: "aff-1", referralCode: "REF-A" }),
    );

    await distributeCommissions("sub-1", 50000);

    expect(Commission.create).toHaveBeenCalledWith(
      expect.objectContaining({ beneficiary: "aff-1", level: 1, amount: 32500 }),
    );
  });

  it("skips an affiliate whose own paid month has ended, even if still marked active", async () => {
    (User.findById as any).mockResolvedValue({ referredBy: "REF-A" });
    (User.findOne as any).mockResolvedValueOnce(
      affiliate({ id: "aff-1", referralCode: "REF-A", subscription: "active", paidUntil: monthsAgo(2) }),
    );

    await distributeCommissions("sub-1", 5000);

    expect(Commission.create).not.toHaveBeenCalled();
  });

  it("uses the commission rates set in the admin panel", async () => {
    (Settings.findOne as any).mockReturnValueOnce({
      select: vi.fn().mockResolvedValue({ commissionLevel1: 50 }),
    });
    (User.findById as any).mockResolvedValue({ referredBy: "REF-A" });
    (User.findOne as any).mockResolvedValueOnce(
      affiliate({ id: "aff-1", referralCode: "REF-A" }),
    );

    await distributeCommissions("sub-1", 10000);

    expect(Commission.create).toHaveBeenCalledWith(
      expect.objectContaining({ beneficiary: "aff-1", level: 1, amount: 5000 }),
    );
  });

  it("does not count a renewal as a new referral", async () => {
    (User.findById as any).mockResolvedValue({ referredBy: "REF-A" });
    (User.findOne as any).mockResolvedValueOnce(
      affiliate({ id: "aff-1", referralCode: "REF-A" }),
    );

    await distributeCommissions("sub-1", 5000, { firstPayment: false });

    expect(User.findByIdAndUpdate).not.toHaveBeenCalled();
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

    await distributeCommissions("sub-1", 5000, { firstPayment: true });

    expect(User.findByIdAndUpdate).toHaveBeenCalledWith(expect.anything(), {
      $inc: { referrals: 1 },
    });
  });
});
