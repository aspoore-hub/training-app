import { useWindowDimensions } from "react-native";

export const COACH_MOBILE_BREAKPOINT = 768;

export function useIsCoachMobileView() {
  const { width } = useWindowDimensions();
  return width > 0 && width < COACH_MOBILE_BREAKPOINT;
}
