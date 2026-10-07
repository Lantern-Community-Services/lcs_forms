import type { Config } from "tailwindcss";
import { frameTheme, framePlugin } from "./tailwind.theme";

/**
 * Styles for the code-form runtime (public/app-runtime/runtime.css): the app's
 * base styles and tokens plus every class the components it provides use.
 * Breakpoints follow the host window (see framePlugin). A code form's own
 * classes are compiled on the server (backend/src/apps/compile.ts) the same way.
 */
export default {
  darkMode: "class",
  content: [
    "./app-runtime/**/*.{ts,tsx}",
    "./src/components/ui/**/*.{ts,tsx}",
    "./src/components/attendance/SignaturePad.tsx",
    "./src/components/charts/Charts.tsx",
    "./src/components/charts/DateRange.tsx",
    // The design kit gallery (src/apps/design.ts) renders with this stylesheet too.
    "./src/apps/design.ts",
  ],
  theme: frameTheme,
  plugins: [framePlugin],
} satisfies Config;
