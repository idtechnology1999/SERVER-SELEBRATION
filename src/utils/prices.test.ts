import { describe, it, expect, vi } from "vitest";

vi.mock("../models/Settings.js", () => ({
  Settings: {
    findOne: vi.fn(() => ({
      select: vi.fn().mockResolvedValue({ get: () => ({ shark: 60000, whale: "bad" }) }),
    })),
  },
}));

import { getStagePrices, parseStagePrices } from "./prices.js";

describe("stage prices", () => {
  it("uses admin prices where set and defaults elsewhere", async () => {
    expect(await getStagePrices()).toEqual({ fish: 5000, dolphin: 15000, shark: 60000, whale: 150000 });
  });

  it("accepts whole Naira amounts from the admin form", () => {
    expect(parseStagePrices({ fish: "6000", dolphin: 20000 })).toEqual({ ok: true, prices: { fish: 6000, dolphin: 20000 } });
  });

  it("rejects zero, negative, fractional or missing values", () => {
    expect(parseStagePrices({ fish: 0 }).ok).toBe(false);
    expect(parseStagePrices({ shark: -5 }).ok).toBe(false);
    expect(parseStagePrices({ whale: 1500.5 }).ok).toBe(false);
    expect(parseStagePrices(null).ok).toBe(false);
  });
});
