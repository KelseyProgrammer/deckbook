import { beforeEach, describe, expect, it, vi } from "vitest";

const close = vi.hoisted(() => vi.fn());
vi.mock("./stripe", () => ({
  stripeClient: () => ({ v2: { core: { accounts: { close } } } }),
}));

import { closeRecipientAccount } from "./connect";

beforeEach(() => vi.clearAllMocks());

describe("closeRecipientAccount", () => {
  it("closes the account with its recipient configuration", async () => {
    close.mockResolvedValue({ id: "acct_1" });
    await closeRecipientAccount("acct_1");
    expect(close).toHaveBeenCalledWith("acct_1", { applied_configurations: ["recipient"] });
  });
  it("propagates Stripe failures to the caller", async () => {
    close.mockRejectedValue(new Error("balance remaining"));
    await expect(closeRecipientAccount("acct_1")).rejects.toThrow("balance remaining");
  });
});
