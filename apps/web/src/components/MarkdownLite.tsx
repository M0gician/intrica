import type { FileReferenceOrigin } from "@intrica/contracts";
import { createContext, memo, useContext } from "react";
import ReactMarkdown, { type Components, defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { FileReferenceView } from "../features/files/FileReferenceView";
import { isLocalFile, isOwnerFileUrl } from "../features/files/reference";
import { tr } from "../i18n";

const FileOrigin = createContext<FileReferenceOrigin | undefined>(undefined);

// Keep renderer types stable. Modal notifications and streaming updates rerender
// the transcript; replacing a renderer would discard its file preview state.
const components: Components = {
  a: function MarkdownLink({ children, href, node: _node, ...props }) {
    const origin = useContext(FileOrigin);
    return isLocalFile(href ?? "") ? (
      origin ? (
        <FileReferenceView origin={origin} path={href}>
          {children}
        </FileReferenceView>
      ) : (
        <span title={tr("文件引用缺少来源信息")}>{children}</span>
      )
    ) : href ? (
      <a {...props} href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    );
  },
  img: function MarkdownImage({ src, alt }) {
    const origin = useContext(FileOrigin);
    return isLocalFile(typeof src === "string" ? src : "") ? (
      origin ? (
        <FileReferenceView origin={origin} path={src as string} image label={alt} />
      ) : (
        <span>
          {alt} · {tr("文件引用缺少来源信息")}
        </span>
      )
    ) : src ? (
      <img src={src} alt={alt} loading="lazy" />
    ) : (
      <span>
        {alt} · {tr("文件引用不可用")}
      </span>
    );
  },
  table: ({ children }) => (
    <div className="markdown-table-scroll">
      <table>{children}</table>
    </div>
  ),
};

/** Markdown renders to React elements. Raw HTML stays inert; HTML preview is separately sandboxed. */
export const MarkdownLite = memo(function MarkdownLite({
  text,
  origin,
}: {
  text: string;
  origin?: FileReferenceOrigin | undefined;
}) {
  return (
    <div className="markdown-lite">
      <FileOrigin.Provider value={origin}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          urlTransform={(url) =>
            isOwnerFileUrl(url) ? "" : isLocalFile(url) ? url : defaultUrlTransform(url)
          }
          components={components}
        >
          {text}
        </ReactMarkdown>
      </FileOrigin.Provider>
    </div>
  );
});
