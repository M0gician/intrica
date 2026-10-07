import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Markdown renders to React elements. Raw HTML stays inert; HTML preview is separately sandboxed. */
export const MarkdownLite = memo(function MarkdownLite({ text }: { text: string }) {
  return (
    <div className="markdown-lite">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div className="markdown-table-scroll">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
