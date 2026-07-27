"use client";

import { useSettings } from "@/lib/settings";

/**
 * Board looks, shared by every board in the app (analysis, play, training).
 *
 * Each theme owns its own last-move highlight: a tint that reads on walnut is
 * invisible on slate, so the highlight travels with the squares rather than
 * being one global colour.
 *
 * Types mirror react-chessboard's props (plain style records, not
 * CSSProperties) so a theme can be spread straight onto <Chessboard />.
 */
export interface BoardTheme {
  id: string;
  label: string;
  light: string;
  dark: string;
  /** Tint for the square a piece left, and the one it landed on. */
  fromTint: string;
  toTint: string;
}

export const BOARD_THEMES: BoardTheme[] = [
  {
    id: "periwinkle",
    label: "Periwinkle",
    light: "#E8EDFA",
    dark: "#5A73CF",
    fromTint: "rgba(255, 197, 61, 0.55)",
    toTint: "rgba(255, 197, 61, 0.68)",
  },
  {
    id: "forest",
    label: "Forest",
    light: "#EDEED1",
    dark: "#779556",
    fromTint: "rgba(255, 236, 92, 0.6)",
    toTint: "rgba(255, 236, 92, 0.72)",
  },
  {
    id: "walnut",
    label: "Walnut",
    light: "#F0D9B5",
    dark: "#B58863",
    fromTint: "rgba(120, 200, 255, 0.5)",
    toTint: "rgba(120, 200, 255, 0.62)",
  },
  {
    id: "slate",
    label: "Slate",
    light: "#DCE1E7",
    dark: "#8CA2AD",
    fromTint: "rgba(255, 197, 61, 0.55)",
    toTint: "rgba(255, 197, 61, 0.68)",
  },
  {
    id: "contrast",
    label: "High contrast",
    light: "#FFFFFF",
    dark: "#3A4A63",
    fromTint: "rgba(255, 214, 0, 0.65)",
    toTint: "rgba(255, 214, 0, 0.8)",
  },
];

export const DEFAULT_THEME = BOARD_THEMES[0];

export function themeById(id: string): BoardTheme {
  return BOARD_THEMES.find((t) => t.id === id) ?? DEFAULT_THEME;
}

/** Props for <Chessboard {...boardProps(theme, showCoordinates)} />. */
export function boardProps(theme: BoardTheme, showCoordinates = true) {
  return {
    customBoardStyle: {
      borderRadius: "8px",
      boxShadow: "0 18px 50px rgba(3, 5, 16, 0.6)",
    } as Record<string, string | number>,
    customDarkSquareStyle: { backgroundColor: theme.dark } as Record<string, string>,
    customLightSquareStyle: { backgroundColor: theme.light } as Record<string, string>,
    showBoardNotation: showCoordinates,
  };
}

/**
 * The active board, from the user's saved settings. Use this anywhere a board
 * is rendered so a theme change applies everywhere at once.
 */
export function useBoardTheme() {
  const settings = useSettings();
  const theme = themeById(settings.boardTheme);
  return {
    theme,
    props: boardProps(theme, settings.showCoordinates),
    lastMoveFrom: { background: theme.fromTint },
    lastMoveTo: { background: theme.toTint },
    animationMs: settings.animationMs,
  };
}
