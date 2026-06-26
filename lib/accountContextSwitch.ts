import {
  routeForAccountContext,
  setActiveAccountContext,
  type AccountContext,
} from "./accountContexts";
import { clearAthleteSessionContextCache } from "./athleteSession";
import { teamDataStore } from "./teamDataStore";

export async function switchAccountContext(
  context: AccountContext,
  options?: { coachDefault?: "calendar" | "home" }
) {
  await setActiveAccountContext(context);
  clearAthleteSessionContextCache();
  await teamDataStore.actions.resetForContextSwitch(context.teamId);
  return routeForAccountContext(context, options);
}
