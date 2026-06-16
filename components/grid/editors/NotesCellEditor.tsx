import { TextCellEditor } from "./TextCellEditor";
import type { GridCellBinding } from "../GridTypes";

type Props = {
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  style?: any;
  inputRef?: any;
  binding?: GridCellBinding;
  webProps?: any;
  editable?: boolean;
};

export function NotesCellEditor(props: Props) {
  return (
    <TextCellEditor
      {...props}
      numberOfLines={3}
    />
  );
}
