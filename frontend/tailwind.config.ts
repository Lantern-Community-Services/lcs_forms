import type { Config } from "tailwindcss";
import { theme } from "./tailwind.theme";

/** Design tokens live in tailwind.theme.ts (shared with code forms). */
export default {
  darkMode: "class",
  content: ["./src/**/*.{ts,tsx}", "./app-runtime/**/*.{ts,tsx}"],
  theme,
  plugins: [],
} satisfies Config;
