import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { html } from "@codemirror/lang-html";
import { markdown } from "@codemirror/lang-markdown";
import {
  defaultHighlightStyle,
  LanguageDescription,
  syntaxHighlighting,
} from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, placeholder } from "@codemirror/view";
import type { FileReferenceOrigin } from "@intrica/contracts";
import { useEffect, useRef, useState } from "react";
import { useSessionConnection } from "../api/connection";
import { type DocumentSave, useDocumentDraft } from "../features/conversations/useDocumentDraft";
import { HtmlFilePreview } from "../features/files/HtmlFilePreview";
import { tr, useTranslation } from "../i18n";
import { Button } from "../ui/button";
import { IconButton, IconCode, IconPreview, IconSave } from "./icons";
import { MarkdownLite } from "./MarkdownLite";
import { TodoList } from "./TodoList";

export function DocumentEditor({
  id,
  value,
  onSave,
  readOnly = false,
  taskList = false,
  fileName,
  version,
  fileOrigin,
  fileMime,
}: {
  id: string;
  value: string;
  onSave?: DocumentSave;
  version?: number;
  readOnly?: boolean;
  taskList?: boolean;
  fileName?: string;
  fileOrigin?: FileReferenceOrigin | undefined;
  fileMime?: string | undefined;
}) {
  useTranslation();

  const { storageKey } = useSessionConnection();
  id = storageKey(id);
  const codeLanguage = fileName ? LanguageDescription.matchFilename(languages, fileName) : null;
  const isCodeFile = fileMime
    ? !["text/markdown", "text/html"].includes(fileMime)
    : Boolean(fileName && !/\.(md|markdown|mdx|html?|xhtml)$/i.test(fileName));
  const { text, current, saved, status, conflict, save, changeText, loadLatest, keepDraft } =
    useDocumentDraft({ id, value, version, readOnly, onSave });
  const [preview, setPreview] = useState(!isCodeFile && value.trim().length > 0 && text === value);
  const [format, setFormat] = useState<"markdown" | "html" | "code">(
    isCodeFile
      ? "code"
      : fileMime === "text/html" ||
          /^\s*<(?:!doctype|html|div|p|h[1-6]|article|section|table)\b/i.test(value)
        ? "html"
        : "markdown",
  );
  const [lineWrap, setLineWrap] = useState(false);
  const surface = useRef<HTMLDivElement>(null);
  const scrollRatio = useRef(0);
  const togglePreview = () => {
    const el = preview
      ? surface.current?.querySelector(".document-preview")
      : editor.current?.scrollDOM;
    if (el) scrollRatio.current = el.scrollTop / Math.max(1, el.scrollHeight - el.clientHeight);
    setPreview(!preview);
  };
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const editorState = useRef<EditorState | null>(null);
  const language = useRef(new Compartment());
  const wrapping = useRef(new Compartment());
  const edit = useRef(changeText);
  edit.current = changeText;
  useEffect(() => {
    if (editor.current && editor.current.state.doc.toString() !== text)
      editor.current.dispatch({
        changes: { from: 0, to: editor.current.state.doc.length, insert: text },
      });
  }, [text]);
  useEffect(() => {
    if (preview || format !== "code" || !editor.current || !codeLanguage) return;
    let cancelled = false;
    void codeLanguage.load().then((support) => {
      if (!cancelled && editor.current)
        editor.current.dispatch({ effects: language.current.reconfigure(support) });
    });
    return () => {
      cancelled = true;
    };
  }, [preview, format, codeLanguage]);
  // The editor is recreated only when the surface changes; lineWrap is
  // reconfigured in the dedicated effect below to preserve undo/history.
  // biome-ignore lint/correctness/useExhaustiveDependencies: lineWrap is intentionally reconfigured without recreating the editor.
  useEffect(() => {
    if (preview || !host.current) return;
    const view = new EditorView({
      parent: host.current,
      state:
        editorState.current ??
        EditorState.create({
          doc: current.current,
          extensions: [
            lineNumbers(),
            history(),
            syntaxHighlighting(defaultHighlightStyle),
            language.current.of(format === "html" ? html() : format === "code" ? [] : markdown()),
            wrapping.current.of(lineWrap ? EditorView.lineWrapping : []),
            EditorView.contentAttributes.of({
              "aria-label": tr("编辑节点正文"),
              spellcheck: "false",
            }),
            EditorState.readOnly.of(readOnly),
            EditorView.editable.of(!readOnly),
            placeholder(tr("直接输入内容，支持 Markdown\u2026")),
            keymap.of([
              {
                key: "Mod-s",
                run: () => {
                  void save.current();
                  return true;
                },
              },
              ...defaultKeymap,
              ...historyKeymap,
            ]),
            EditorView.domEventHandlers({
              blur: () => {
                void save.current();
              },
            }),
            EditorView.updateListener.of((update) => {
              if (!update.docChanged) return;
              edit.current(update.state.doc.toString());
            }),
          ],
        }),
    });
    editor.current = view;
    if (view.state.doc.toString() !== current.current)
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: current.current } });
    return () => {
      editorState.current = view.state;
      editor.current = null;
      view.destroy();
    };
  }, [preview, id, readOnly, format]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 从预览返回源码时也需要恢复当前语言。
  useEffect(() => {
    editor.current?.dispatch({
      effects: language.current.reconfigure(
        format === "html" ? html() : format === "code" ? [] : markdown(),
      ),
    });
  }, [format, preview]);
  useEffect(() => {
    let cancelled = false;
    if (!isCodeFile || !codeLanguage || !editor.current) return;
    void codeLanguage.load().then((extension) => {
      if (!cancelled)
        editor.current?.dispatch({ effects: language.current.reconfigure(extension) });
    });
    return () => {
      cancelled = true;
    };
  }, [codeLanguage, isCodeFile]);
  useEffect(() => {
    editor.current?.dispatch({
      effects: wrapping.current.reconfigure(lineWrap ? EditorView.lineWrapping : []),
    });
  }, [lineWrap]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const el = preview
        ? surface.current?.querySelector(".document-preview")
        : editor.current?.scrollDOM;
      if (el) el.scrollTop = scrollRatio.current * Math.max(0, el.scrollHeight - el.clientHeight);
    });
    return () => cancelAnimationFrame(frame);
  }, [preview]);
  const statusLabel = {
    saved: tr("已保存"),
    dirty: tr("未保存"),
    saving: tr("保存中\u2026"),
    failed: tr("保存失败，草稿已保留"),
    conflict: tr("内容已更新，草稿已保留"),
  }[status];
  return (
    <div ref={surface} className="document-editor">
      {conflict && (
        <div className="workspace-error" role="alert">
          {tr("正文已在其他窗口更新，草稿已保留。")}
          <Button
            type="button"
            onClick={() => {
              loadLatest();
            }}
          >
            {tr("载入新内容")}
          </Button>
          <Button
            type="button"
            onClick={() => {
              keepDraft();
            }}
          >
            {tr("保存我的草稿")}
          </Button>
        </div>
      )}
      <div className="document-toolbar">
        <select
          aria-label={tr("正文格式")}
          value={format}
          disabled={isCodeFile}
          onChange={(e) => setFormat(e.target.value as typeof format)}
        >
          <option value="markdown">Markdown</option>
          <option value="html">HTML</option>
          {isCodeFile && (
            <option value="code">
              {tr("代码（")}
              {codeLanguage?.name ?? tr("纯文本")}）
            </option>
          )}
        </select>
        <span
          role="status"
          title={statusLabel}
          className={status === "failed" ? "save-error" : "save-status"}
        >
          {readOnly ? tr("只读文件") : statusLabel}
        </span>
        {!readOnly && (
          <IconButton
            label={tr("保存正文")}
            disabled={text === saved.current}
            onClick={() => void save.current()}
          >
            <IconSave />
          </IconButton>
        )}
        {!isCodeFile && (
          <IconButton
            label={preview ? tr("查看源码") : tr("预览正文")}
            active={preview}
            onClick={togglePreview}
          >
            {preview ? <IconCode /> : <IconPreview />}
          </IconButton>
        )}
        {!isCodeFile && preview ? (
          <span className="document-wrap-placeholder" aria-hidden="true" />
        ) : (
          <label className="document-wrap-toggle">
            <input
              type="checkbox"
              checked={lineWrap}
              onChange={(event) => setLineWrap(event.target.checked)}
            />
            {tr("自动换行")}
          </label>
        )}
      </div>
      {preview ? (
        <div className="document-preview">
          {format === "html" ? (
            <HtmlFilePreview text={text} origin={fileOrigin} />
          ) : taskList ? (
            <TodoList
              text={text}
              onSave={async (next) => {
                changeText(next);
                await save.current();
                return saved.current === next;
              }}
            />
          ) : (
            <MarkdownLite text={text} origin={fileOrigin} />
          )}
        </div>
      ) : (
        <div ref={host} className={`source-editor${lineWrap ? " is-wrapped" : ""}`} />
      )}
    </div>
  );
}
