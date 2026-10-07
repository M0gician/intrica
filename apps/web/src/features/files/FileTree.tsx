import { useEffect, useState } from "react";
import { useSessionConnection } from "../../api/connection";
import type { DirectoryListing, WorkspaceEntry } from "../../api/workspace";
import { IconButton, IconGroup, IconPlus, IconText } from "../../components/icons";
import { tr, useTranslation } from "../../i18n";
import { Button } from "../../ui/button";
import { LOCAL_RESOURCE_MIME } from "../../utils/imports";

export function TreeEntry({
  item,
  onOpen,
  onAdd,
  onDownload,
  downloading,
}: {
  item: WorkspaceEntry;
  onOpen: (item: WorkspaceEntry) => void;
  onAdd: (item: WorkspaceEntry) => void;
  onDownload: (item: WorkspaceEntry) => void;
  downloading: boolean;
}) {
  useTranslation();

  const { serverRequest } = useSessionConnection();
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<WorkspaceEntry[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open || item.type !== "directory") return;
    const abort = new AbortController();
    void serverRequest<DirectoryListing>(
      `files?path=${encodeURIComponent(item.path)}`,
      undefined,
      "GET",
      abort.signal,
    )
      .then((result) => {
        if (abort.signal.aborted) return;
        setChildren(result.entries);
        setError(result.truncated ? tr("目录过大，请搜索具体文件") : "");
      })
      .catch((error) => {
        if (!abort.signal.aborted) setError(String(error));
      });
    return () => abort.abort();
  }, [open, item.path, item.type, serverRequest]);
  return (
    <li>
      <div className="file-tree-row">
        <button
          type="button"
          className="file-entry"
          aria-label={item.name}
          draggable
          onDragStart={(event) => {
            event.dataTransfer.setData(LOCAL_RESOURCE_MIME, JSON.stringify(item));
            event.dataTransfer.effectAllowed = "copy";
          }}
          aria-expanded={item.type === "directory" ? open : undefined}
          onClick={() => (item.type === "directory" ? setOpen(!open) : onOpen(item))}
        >
          <span className="tree-chevron" aria-hidden="true">
            {item.type === "directory" ? (open ? "⌄" : "›") : ""}
          </span>
          {item.type === "directory" ? <IconGroup /> : <IconText />}
          <span>{item.name}</span>
        </button>
        <IconButton
          label={tr("添加 {{v0}} 到画布", { v0: item.name })}
          caption={tr("添加到画布")}
          onClick={() => onAdd(item)}
        >
          <IconPlus size={14} />
        </IconButton>
        {item.type === "file" && (
          <Button
            type="button"
            disabled={downloading}
            onClick={() => onDownload(item)}
            aria-label={tr("下载 {{v0}} 到此设备", { v0: item.name })}
          >
            {tr("下载")}
          </Button>
        )}
      </div>
      {open && (
        <ul className="local-file-tree">
          {children ? (
            children.map((child) => (
              <TreeEntry
                key={child.path}
                item={child}
                onOpen={onOpen}
                onAdd={onAdd}
                onDownload={onDownload}
                downloading={downloading}
              />
            ))
          ) : !error ? (
            <li className="tree-status">{tr("读取中\u2026")}</li>
          ) : null}
          {error && <li className="tree-status">{error}</li>}
        </ul>
      )}
    </li>
  );
}
