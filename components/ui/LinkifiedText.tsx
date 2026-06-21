import { Linking, Platform, Text, type StyleProp, type TextProps, type TextStyle } from "react-native";

const HTTP_URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;
const TRAILING_URL_PUNCTUATION_PATTERN = /[),.;!?]+$/;

type ParsedLine = {
  text: string;
  urls: string[];
};

type LinkifiedTextProps = Omit<TextProps, "children"> & {
  text: string;
  linkStyle?: StyleProp<TextStyle>;
};

function splitUrl(rawMatch: string): string {
  const trailingMatch = rawMatch.match(TRAILING_URL_PUNCTUATION_PATTERN);
  const trailing = trailingMatch?.[0] ?? "";
  return trailing ? rawMatch.slice(0, -trailing.length) : rawMatch;
}

function normalizeLineText(input: string): string {
  return input.replace(/[ \t]{2,}/g, " ").trim();
}

export function containsHttpUrl(input: unknown): boolean {
  return /https?:\/\/[^\s<>"']+/i.test(String(input ?? ""));
}

function parseLine(input: string): ParsedLine {
  const pattern = new RegExp(HTTP_URL_PATTERN);
  const urls: string[] = [];
  const textPieces: string[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(input))) {
    const rawMatch = match[0];
    const start = match.index;
    if (start > lastIndex) {
      textPieces.push(input.slice(lastIndex, start));
    }

    const url = splitUrl(rawMatch);
    if (url) urls.push(url);
    lastIndex = start + rawMatch.length;
  }

  if (lastIndex < input.length) {
    textPieces.push(input.slice(lastIndex));
  }

  return {
    text: urls.length > 0 ? normalizeLineText(textPieces.join("")) : input,
    urls,
  };
}

function openHttpUrl(url: string, event?: any) {
  event?.stopPropagation?.();
  if (!/^https?:\/\//i.test(url)) return;

  if (Platform.OS === "web" && typeof window !== "undefined" && typeof window.open === "function") {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }

  void Linking.openURL(url).catch((error) => {
    console.warn("[linkified-text] open url failed", { url, error });
  });
}

export function LinkifiedText({ text, style, linkStyle, ...textProps }: LinkifiedTextProps) {
  const lines = String(text ?? "").split("\n");

  return (
    <Text {...textProps} style={style}>
      {lines.map((line, lineIndex) => {
        const parsed = parseLine(line);
        const hasText = parsed.text.trim().length > 0;
        const multipleUrls = parsed.urls.length > 1;
        return (
          <Text key={`line-${lineIndex}`}>
            {hasText ? parsed.text : null}
            {!hasText && parsed.urls.length === 0 ? line : null}
            {parsed.urls.map((url, urlIndex) => {
              const label = hasText
                ? "↗"
                : multipleUrls
                ? `Open link ${urlIndex + 1} ↗`
                : "Open link ↗";
              return (
                <Text
                  key={`${url}-${urlIndex}`}
                  accessibilityRole="link"
                  onPress={(event) => openHttpUrl(url, event)}
                  style={[
                    {
                      color: "#2563eb",
                      textDecorationLine: "underline",
                      fontWeight: "900",
                    },
                    linkStyle,
                  ]}
                >
                  {hasText || urlIndex > 0 ? "  " : ""}
                  {label}
                </Text>
              );
            })}
            {lineIndex < lines.length - 1 ? "\n" : null}
          </Text>
        );
      })}
    </Text>
  );
}
