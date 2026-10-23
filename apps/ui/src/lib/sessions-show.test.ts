import { describe, expect, test } from "bun:test";
import { getSessionsShow, sessionsShowParam, setSessionsShow } from "./sessions-show";

describe("sessions Mine / All view", () => {
  test("defaults to Mine, which sends no param", () => {
    expect(getSessionsShow()).toBe("mine");
    expect(sessionsShowParam("mine")).toEqual({});
  });
  test("All sticks and sends show=all", () => {
    setSessionsShow("all");
    expect(getSessionsShow()).toBe("all");
    expect(sessionsShowParam(getSessionsShow())).toEqual({ show: "all" });
    setSessionsShow("mine");
    expect(getSessionsShow()).toBe("mine");
  });
});
