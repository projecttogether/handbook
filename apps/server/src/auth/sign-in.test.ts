import { afterEach, describe, expect, it } from "vitest";
import { resetConfigForTests } from "../config";
import { checkProviderUserInfo, claimGroups, inAllowedGroup, jwtClaims, readClaim } from "./sign-in";

const token = (claims: Record<string, unknown>) =>
  `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;

describe("claims", () => {
  it("reads the claims of a JWT and nested claims by a dotted name", () => {
    const claims = jwtClaims(token({ sub: "a", realm_access: { roles: ["staff"] }, "x.y": 1 }));
    expect(claims?.sub).toBe("a");
    expect(readClaim(claims, "realm_access.roles")).toEqual(["staff"]);
    expect(readClaim(claims, "x.y")).toBe(1);
    expect(readClaim(claims, "missing.claim")).toBeUndefined();
    expect(jwtClaims("not-a-jwt")).toBeNull();
    expect(jwtClaims(null)).toBeNull();
  });

  it("takes groups from a list or a comma-separated string, and nothing else", () => {
    expect(claimGroups(["/staff", "/it", 7, null])).toEqual(["/staff", "/it"]);
    expect(claimGroups(" staff , it ,, ")).toEqual(["staff", "it"]);
    expect(claimGroups(undefined)).toEqual([]);
    expect(claimGroups({ staff: true })).toEqual([]);
  });
});

describe("inAllowedGroup", () => {
  it("admits members of an allowed group and of its subgroups", () => {
    expect(inAllowedGroup(["/staff"], ["/staff"])).toBe(true);
    expect(inAllowedGroup(["/staff/it"], ["/staff"])).toBe(true);
    expect(inAllowedGroup(["staff/it/"], ["/staff"])).toBe(true);
    expect(inAllowedGroup(["/other", "/staff"], ["/admins", "staff"])).toBe(true);
  });

  it("refuses everyone else, including look-alike names", () => {
    expect(inAllowedGroup(["/staffing"], ["/staff"])).toBe(false);
    expect(inAllowedGroup(["/guests/staff"], ["/staff"])).toBe(false);
    expect(inAllowedGroup(["/staff"], ["/staff/it"])).toBe(false);
    expect(inAllowedGroup([], ["/staff"])).toBe(false);
  });
});

describe("checkProviderUserInfo", () => {
  afterEach(() => {
    delete process.env.OIDC_REQUIRE_EMAIL_VERIFIED;
    resetConfigForTests();
  });

  it("refuses an email address the provider has not verified", () => {
    expect(checkProviderUserInfo({ emailVerified: true })).toBeUndefined();
    expect(checkProviderUserInfo({ emailVerified: false })).toEqual({
      error: "email_not_verified",
      errorDescription: "The provider has not verified this email address",
    });
    expect(checkProviderUserInfo({})?.error).toBe("email_not_verified");
    expect(checkProviderUserInfo({ emailVerified: "true" })?.error).toBe("email_not_verified");
  });

  it("lets every address through when OIDC_REQUIRE_EMAIL_VERIFIED is off", () => {
    process.env.OIDC_REQUIRE_EMAIL_VERIFIED = "false";
    resetConfigForTests();
    expect(checkProviderUserInfo({ emailVerified: false })).toBeUndefined();
  });
});
