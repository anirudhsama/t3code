import type { MenuAction } from "@react-native-menu/menu";
import type { ColorValue } from "react-native";

export function applyDefaultMenuImageColors(
  actions: readonly MenuAction[],
  colors: { readonly default: ColorValue; readonly destructive: ColorValue },
): MenuAction[] {
  return actions.map((action) => ({
    ...action,
    ...(action.image !== undefined && action.imageColor === undefined
      ? {
          imageColor: action.attributes?.destructive === true ? colors.destructive : colors.default,
        }
      : {}),
    ...(action.subactions
      ? { subactions: applyDefaultMenuImageColors(action.subactions, colors) }
      : {}),
  }));
}
