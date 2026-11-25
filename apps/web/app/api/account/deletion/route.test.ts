import { beforeEach, describe, expect, it, vi } from "vitest";

const seams = vi.hoisted(() => ({ getSession: vi.fn(), deletionBlockers: vi.fn() }));

vi.mock("../../../../lib/auth", () => ({ auth: { api: { getSession: seams.getSession } } }));
vi.mock("../../../../lib/account-deletion", () => ({ deletionBlockers: seams.deletionBlockers }));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Headers()) }));

import { GET } from "./route";

const USER = { id: "u1", email: "c@x.test", accountType: "CREW" };

beforeEach(() => {
  vi.clearAllMocks();
  seams.getSession.mockResolvedValue({ user: USER });
  seams.deletionBlockers.mockResolvedValue([]);
});

describe("GET /api/account/deletion", () => {
  it("401 when signed out", async () => {
    seams.getSession.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
    expect(seams.deletionBlockers).not.toHaveBeenCalled();
  });
  it("canDelete true with no blockers", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ canDelete: true, blockers: [] });
    expect(seams.deletionBlockers).toHaveBeenCalledWith({
      id: "u1",
      email: "c@x.test",
      accountType: "CREW",
    });
  });
  it("canDelete false and lists blockers", async () => {
    const blockers = [{ kind: "OPEN_BOOKING", bookingId: "b1", state: "ACCEPTED" }];
    seams.deletionBlockers.mockResolvedValue(blockers);
    expect(await (await GET()).json()).toEqual({ canDelete: false, blockers });
  });
});
