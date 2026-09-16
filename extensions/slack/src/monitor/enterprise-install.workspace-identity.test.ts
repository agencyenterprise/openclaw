import { expect, it } from "vitest";
import { resolveSlackInstallationIdentity } from "./enterprise-install.js";
it("uses trusted Socket Mode identity for a workspace response without app_id", () => {
  expect(resolveSlackInstallationIdentity({enterpriseOrgInstall:false,transportApiAppId:"A123",auth:{team_id:"T123",is_enterprise_install:false}})).toEqual({kind:"workspace",teamId:"T123",apiAppId:"A123"});
});
it("refuses conflicting workspace bot and transport identity", () => {
  expect(()=>resolveSlackInstallationIdentity({enterpriseOrgInstall:false,transportApiAppId:"A_OTHER",auth:{team_id:"T123",app_id:"A123",is_enterprise_install:false}})).toThrow(/token mismatch/);
});
it("does not manufacture workspace identity after failed authentication", () => {
  expect(resolveSlackInstallationIdentity({enterpriseOrgInstall:false,transportApiAppId:"A123",authError:new Error("unavailable")})).toEqual({kind:"degraded",reason:"auth_test_failed"});
});
