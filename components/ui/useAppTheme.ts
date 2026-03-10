import { useColorScheme } from "react-native";
import { colors, theme } from "../../lib/theme";

export function useAppTheme() {
  const scheme = useColorScheme();
  const palette = scheme === "dark" ? colors.dark : colors.light;

  return { theme, colors: palette, scheme: scheme ?? "light" };
}
