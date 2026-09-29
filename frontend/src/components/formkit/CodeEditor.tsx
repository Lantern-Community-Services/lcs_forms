import { useEffect, useRef } from "react";
import { EditorView, basicSetup } from "codemirror";
import { EditorState, type Extension } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { json } from "@codemirror/lang-json";
import { javascript } from "@codemirror/lang-javascript";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { oneDark } from "@codemirror/theme-one-dark";
import { cn } from "@/lib/utils";

/**
 * CodeMirror 6, for the form's JSON and custom code blocks. Controlled loosely:
 * `value` replaces the document only when it differs from what the editor
 * holds, so typing never fights a re-render.
 */
const LANGS: Record<string, () => Extension> = { json, javascript, html, css, typescript: () => javascript({ typescript: true, jsx: true }) };

function isDark() {
  return typeof document !== "undefined" && document.documentElement.classList.contains("dark");
}

export function CodeEditor({
  value,
  onChange,
  language = "json",
  className,
  minHeight = 160,
  readOnly,
  jump,
  fill,
}: {
  value: string;
  onChange?: (v: string) => void;
  language?: "json" | "javascript" | "html" | "css" | "typescript";
  className?: string;
  minHeight?: number;
  readOnly?: boolean;
  /** Move the cursor to a line (1-based); change `n` to jump again to the same line. */
  jump?: { line: number; column?: number; n: number };
  /** Fill the parent's height instead of growing with the content. */
  fill?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!host.current) return;
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          keymap.of([indentWithTab]),
          LANGS[language](),
          EditorView.lineWrapping,
          EditorState.readOnly.of(Boolean(readOnly)),
          EditorView.theme({
            "&": { fontSize: "12.5px", ...(fill ? { height: "100%" } : {}) },
            ".cm-scroller": { minHeight: `${minHeight}px`, fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace" },
          }),
          ...(isDark() ? [oneDark] : []),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current?.(u.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = v;
    return () => v.destroy();
    // Recreated only when the language changes; value syncs below.
  }, [language, readOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);

  useEffect(() => {
    const v = view.current;
    if (!v || !jump) return;
    const line = v.state.doc.line(Math.max(1, Math.min(jump.line, v.state.doc.lines)));
    const pos = Math.min(line.to, line.from + Math.max(0, (jump.column ?? 0)));
    v.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
    v.focus();
  }, [jump?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={host} className={cn("overflow-hidden rounded-input border border-hairline bg-surface text-left", fill && "[&_.cm-editor]:h-full", className)} />;
}
