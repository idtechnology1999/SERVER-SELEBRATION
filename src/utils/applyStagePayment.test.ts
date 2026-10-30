import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../models/User.js", () => ({
  User: { findById: vi.fn(), findOne: vi.fn(), findByIdAndUpdate: vi.fn() },
}));
vi.mock("../models/UsedReference.js", () => ({
  UsedReference: { countDocuments: vi.fn(), create: vi.fn(), deleteOne: vi.fn() },
}));
vi.mock("../models/Notification.js", () => ({
  Notification: { create: vi.fn(), insertMany: vi.fn() },
}));
vi.mock("../models/Admin.js", () => ({
  Admin: { find: vi.fn(() => ({ select: vi.fn().mockResolvedValue([{ _id: "admin-1" }]) })) },
}));
vi.mock("./distributeCommissions.js", () => ({ distributeCommissions: vi.fn() }));
vi.mock("./paystack.js", () => ({
  disableSubscription: vi.fn().mockResolvedValue(true),
  stageForPlanCode: vi.fn(),
}));
vi.mock("../socket.js", () => ({ emit: vi.fn() }));

import { applyStagePayment } from "./applyStagePayment.js";
import { User } from "../models/User.js";
import { UsedReference } from "../models/UsedReference.js";
import { Notification } from "../models/Notification.js";
import { distributeCommissions } from "./distributeCommissions.js";
import { disableSubscription } from "./paystack.js";

const DAY = 24 * 60 * 60 * 1000;

const tx = (over: Record<string, any> = {}) => ({
  status: "success",
  currency: "NGN",
  reference: "ref-1",
  amount: 50000 * 100,
  metadata: { type: "stage", stage: "shark", userId: "u1", renewal: "manual" },
  customer: { email: "a@b.com" },
  ...over,
});

const user = (over: Record<string, any> = {}) => ({
  _id: { toString: () => "u1" },
  name: "Ada",
  email: "a@b.com",
  stage: 0,
  subscription: "expired",
  paidUntil: null,
  paystackSubscriptionCode: "",
  paystackEmailToken: "",
  paystackPlanCode: "",
  ...over,
});

// The user is loaded twice: once to apply, once (select) to read the final date.
function mockUser(u: any) {
  (User.findById as any).mockImplementation(() => {
    const p: any = Promise.resolve(u);
    p.select = vi.fn().mockResolvedValue(u);
    return p;
  });
}

const lastUpdate = () => (User.findByIdAndUpdate as any).mock.calls.at(-1)[1];

describe("applyStagePayment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (UsedReference.countDocuments as any).mockResolvedValue(0);
    (UsedReference.create as any).mockResolvedValue({});
  });

  it("first payment for Shark: unlocks stage 3 for one month and pays commissions", async () => {
    mockUser(user({ signupStatus: "awaiting_payment" }));

    const result = await applyStagePayment(tx());

    expect(result).toMatchObject({ status: "applied", stage: "shark" });
    const update = lastUpdate();
    expect(update).toMatchObject({ stage: 3, subscription: "active", signupStatus: "complete" });
    const days = (new Date(update.paidUntil).getTime() - Date.now()) / DAY;
    expect(days).toBeGreaterThan(27);
    expect(days).toBeLessThan(32);
    expect(distributeCommissions).toHaveBeenCalledWith("u1", 50000, { firstPayment: true });
  });

  it("the same payment arriving twice (webhook + return page) is applied once", async () => {
    mockUser(user());
    (UsedReference.create as any).mockRejectedValueOnce(Object.assign(new Error("dup"), { code: 11000 }));

    const result = await applyStagePayment(tx());

    expect(result).toMatchObject({ status: "already_applied" });
    expect(User.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(distributeCommissions).not.toHaveBeenCalled();
  });

  it("renewing the same stage adds a month on top of the current one", async () => {
    const currentEnd = new Date(Date.now() + 5 * DAY);
    mockUser(user({ stage: 3, subscription: "active", paidUntil: currentEnd }));
    (UsedReference.countDocuments as any).mockResolvedValue(1);

    await applyStagePayment(tx({ reference: "ref-2" }));

    const next = new Date(lastUpdate().paidUntil);
    const expected = new Date(currentEnd);
    expected.setMonth(expected.getMonth() + 1);
    expect(next.getTime()).toBe(expected.getTime());
    expect(distributeCommissions).toHaveBeenCalledWith("u1", 50000, { firstPayment: false });
  });

  it("upgrading mid-month moves to the higher stage with a fresh month and stops the old auto-renew", async () => {
    mockUser(user({
      stage: 1, subscription: "active", paidUntil: new Date(Date.now() + 20 * DAY),
      paystackSubscriptionCode: "SUB_old", paystackEmailToken: "tok", paystackPlanCode: "PLN_fish",
    }));
    (UsedReference.countDocuments as any).mockResolvedValue(1);

    await applyStagePayment(tx({ reference: "ref-3" }));

    const update = lastUpdate();
    expect(update.stage).toBe(3);
    const days = (new Date(update.paidUntil).getTime() - Date.now()) / DAY;
    expect(days).toBeGreaterThan(27);
    expect(disableSubscription).toHaveBeenCalledWith("SUB_old", "tok");
    expect(update.paystackSubscriptionCode).toBe("");
  });

  it("paying for Fish during the free trial starts the paid month when the trial ends", async () => {
    const trialEnd = new Date(Date.now() + 4 * DAY);
    mockUser(user({ subscription: "trial", trialEndsAt: trialEnd }));

    await applyStagePayment(tx({ amount: 5000 * 100, metadata: { type: "stage", stage: "fish", userId: "u1" } }));

    const update = lastUpdate();
    const expected = new Date(trialEnd);
    expected.setMonth(expected.getMonth() + 1);
    expect(update.stage).toBe(1);
    expect(new Date(update.paidUntil).getTime()).toBe(expected.getTime());
  });

  it("buying a higher stage during the free trial unlocks it straight away", async () => {
    mockUser(user({ subscription: "trial", trialEndsAt: new Date(Date.now() + 4 * DAY) }));

    await applyStagePayment(tx());

    const update = lastUpdate();
    expect(update.stage).toBe(3);
    const days = (new Date(update.paidUntil).getTime() - Date.now()) / DAY;
    expect(days).toBeGreaterThan(27);
    expect(days).toBeLessThan(32);
  });

  it("ignores a payment below the stage price", async () => {
    mockUser(user());

    const result = await applyStagePayment(tx({ amount: 5000 * 100 }));

    expect(result).toMatchObject({ status: "ignored", reason: "amount_too_low" });
    expect(UsedReference.create).not.toHaveBeenCalled();
  });

  it("flags a payment whose account no longer exists for an admin", async () => {
    mockUser(null);

    const result = await applyStagePayment(tx());

    expect(result).toMatchObject({ status: "ignored", reason: "user_missing" });
    expect(Notification.insertMany).toHaveBeenCalled();
  });
});
