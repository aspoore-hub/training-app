import { CategorySelectCellEditor } from "../CategorySelectCellEditor";
import type { GridCellBinding } from "../GridTypes";

type Props = {
  value: string[];
  options: string[];
  onChange: (nextCategories: string[]) => void;
  style?: any;
  binding?: GridCellBinding;
  onActivate?: () => void;
  onOpenChange?: (open: boolean) => void;
};

export function CategoryCellEditor({
  value,
  options,
  onChange,
  binding,
  onActivate,
  onOpenChange,
}: Props) {
  return (
    <CategorySelectCellEditor
      value={value}
      options={options}
      onChange={onChange}
      binding={binding}
      onActivate={onActivate}
      onOpenChange={onOpenChange}
    />
  );
}
