import { Linking, Platform, Text, type StyleProp, type TextProps, type TextStyle } from "react-native";

const HTTP_URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;
const TRAILING_URL_PUNCTUATION_PATTERN = /[),.;!?]+$/;

type LinkifiedPart =
  | { kind: "text"; value: string }
  | { kind: "link"; value: string };

type LinkifiedTextProps = Omit<TextProps, "children"> & {
  text: string;
  linkStyle?: StyleProp<TextStyle>;
};

export function containsHttpUrl(input: unknown): boolean {
  return /https?:\/\/[^\s<>"']+/i.test(String(input ?? ""));
}

function splitLinkifiedText(input: string): LinkifiedPart[] {
  const parts: LinkifiedPart[] = [];
  const text = String(input ?? "");
  const pattern = new RegExp(HTTP_URL_PATTERN);
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text))) {
    const rawMatch = match[0];
    const start = match.index;
    if (start > lastIndex) {
      parts.push({ kind: "text", value: text.slice(lastIndex, start) });
    }

    const trailingMatch = rawMatch.match(TRAILING_URL_PUNCTUATION_PATTERN);
    const trailing = trailingMatch?.[0] ?? "";
    const url = trailing ? rawMatch.slice(0, -trailing.length) : rawMatch;

    if (url) {
      parts.push({ kind: "link", value: url });
    }
    if (trailing) {
      parts.push({ kind: "text", value: trailing });
    }

    lastIndex = start + rawMatch.length;
  }

  if (lastIndex < text.length) {
    parts.push({ kind: "text", value: text.slice(lastIndex) });
  }

  return parts.length > 0 ? parts : [{ kind: "text", value: text }];
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
  const parts = splitLinkifiedText(String(text ?? ""));

  return (
    <Text {...textProps} style={style}>
      {parts.map((part, index) => {
        if (part.kind === "text") return part.value;
        return (
          <Text
            key={`${part.value}-${index}`}
            onPress={(event) => openHttpUrl(part.value, event)}
            style={[{ color: "#2563eb", textDecorationLine: "underline", fontWeight: "800" }, linkStyle]}
          >
            {part.value}
          </Text>
        );
      })}
    </Text>
  );
}
