import { Text, View } from "react-native";

type Props = {
  value: string;
  style?: any;
  textStyle?: any;
  numberOfLines?: number;
};

export function ReadOnlyCell({ value, style, textStyle, numberOfLines = 1 }: Props) {
  return (
    <View style={style}>
      <Text numberOfLines={numberOfLines} style={textStyle}>
        {value}
      </Text>
    </View>
  );
}
