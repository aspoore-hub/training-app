import { Pressable, Text, View } from "react-native";

type Option = {
  label: string;
  value: string;
};

type Props = {
  value: string;
  options: Option[];
  onChange: (value: string) => void;
  style?: any;
};

export function SelectCellEditor({ value, options, onChange, style }: Props) {
  return (
    <View style={[{ flexDirection: "row", flexWrap: "wrap", gap: 6 }, style]}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <Pressable
            key={option.value}
            onPress={() => onChange(option.value)}
            style={{
              borderWidth: 1,
              borderColor: active ? "#0f172a" : "#cbd5e1",
              backgroundColor: active ? "#0f172a" : "#fff",
              borderRadius: 999,
              paddingHorizontal: 9,
              paddingVertical: 5,
            }}
          >
            <Text style={{ fontSize: 11, fontWeight: "800", color: active ? "#fff" : "#334155" }}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
