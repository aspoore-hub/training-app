import { Platform, useWindowDimensions } from "react-native";

export function useResponsive() {
  const { width, height } = useWindowDimensions();

  const isWeb = Platform.OS === "web";
  const isDesktop = isWeb && width >= 1024;
  const isWide = isWeb && width >= 1280;
  const isShort = height < 700;

  return { width, height, isWeb, isDesktop, isWide, isShort };
}
