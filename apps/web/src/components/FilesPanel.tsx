import { useCallback, useEffect, useRef, useState } from "react";
import { useSessionConnection } from "../api/connection";
import type { DirectoryListing, FileContent, WorkspaceEntry } from "../api/workspace";
import { DownloadStatus, useFileDownload } from "../features/files/download";
import { FilePreview } from "../features/files/FilePreview";
import { TreeEntry } from "../features/files/FileTree";
import { tr, useTranslation } from "../i18n";
import { Button } from "../ui/button";
import { LOCAL_RESOURCE_MIME } from "../utils/imports";
import { FileSource } from "./FileSource";
import { IconArrowUp, IconButton, IconClose, IconPlus, IconRefresh } from "./icons";
import "./files-panel.css";

export function FilesPanel({
  root,
  workspacePath,
  active = true,
  openFileTarget,
  onRoot,
  onAdd,
}: {
  root: string;
  workspacePath?: string | undefined;
  active?: boolean;
  openFileTarget?:
    | {
        path: string;
        nonce: string;
      }
    | undefined;
  onRoot: (path: string) => void;
  onAdd: (item: WorkspaceEntry) => Promise<void>;
}) {
  useTranslation();

  const connection = useSessionConnection();
  const { serverRequest } = connection;
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [search, setSearch] = useState("");
  const [location, setLocation] = useState<string | null>(null);
  const [editingPath, setEditingPath] = useState(false);
  const pathInput = useRef<HTMLInputElement | null>(null);
  const pathTrigger = useRef<HTMLButtonElement | null>(null);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const [receivedFile, setFile] = useState<FileContent | null>(null);
  const file =
    receivedFile?.serverId && receivedFile.serverId !== connection.serverId ? null : receivedFile;
  const fileRequest = useRef<AbortController | null>(null);
  const image = useRef<HTMLImageElement | null>(null);
  const [fileAction, setFileAction] = useState("");
  const download = useFileDownload();
  const copyImage = async () => {
    try {
      if (!navigator.clipboard?.write || !window.ClipboardItem)
        throw new Error(tr("此环境不支持复制图片，请下载到此设备。"));
      const source = image.current;
      if (!source?.naturalWidth) throw new Error(tr("图片尚未加载完成"));
      const canvas = document.createElement("canvas");
      canvas.width = source.naturalWidth;
      canvas.height = source.naturalHeight;
      canvas.getContext("2d")!.drawImage(source, 0, 0);
      const png = new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error("PNG conversion failed"))),
          "image/png",
        ),
      );
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
      setFileAction(tr("图片已复制"));
    } catch (error) {
      setError(String(error));
    }
  };
  const wasActive = useRef(active);
  const openedTarget = useRef("");
  useEffect(
    () => () => {
      fileRequest.current?.abort();
      openedTarget.current = "";
    },
    [],
  );
  useEffect(() => {
    if (editingPath) {
      pathInput.current?.focus();
      pathInput.current?.select();
    }
  }, [editingPath]);
  useEffect(() => {
    if (active && !wasActive.current) setRevision((value) => value + 1);
    wasActive.current = active;
  }, [active]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the same path on a different server is a different resource.
  useEffect(() => {
    fileRequest.current?.abort();
    setFile(null);
    setSearch("");
    setListing(null);
    setLocation(null);
    setError("");
    setFileAction("");
    setEditingPath(false);
  }, [root, connection.bindingId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision and active deliberately reload the same directory.
  useEffect(() => {
    if (!active) return;
    const abort = new AbortController();
    setListing(null);
    const timeout = setTimeout(
      () => {
        void serverRequest<DirectoryListing>(
          `files?path=${encodeURIComponent(root)}&search=${encodeURIComponent(search)}`,
          undefined,
          "GET",
          abort.signal,
        )
          .then((result) => {
            if (abort.signal.aborted) return;
            setListing(result);
            setError("");
          })
          .catch((error) => {
            if (!abort.signal.aborted) setError(String(error));
          });
      },
      search ? 250 : 0,
    );
    return () => {
      clearTimeout(timeout);
      abort.abort();
    };
  }, [active, root, search, revision, connection.bindingId, serverRequest]);
  const openFile = useCallback(
    async (item: WorkspaceEntry) => {
      setFileAction("");
      fileRequest.current?.abort();
      const abort = new AbortController();
      fileRequest.current = abort;
      try {
        const content = await serverRequest<FileContent>(
          `file?path=${encodeURIComponent(item.path)}`,
          undefined,
          "GET",
          abort.signal,
        );
        if (abort.signal.aborted) return;
        setFile(content);
        setError("");
      } catch (error) {
        if (!abort.signal.aborted) setError(String(error));
      }
    },
    [serverRequest],
  );
  useEffect(() => {
    if (!active || !openFileTarget) return;
    const key = `${connection.bindingId}:${openFileTarget.nonce}`;
    if (openedTarget.current === key) return;
    openedTarget.current = key;
    const path = openFileTarget.path;
    void openFile({ name: path.split(/[\\/]/).at(-1) || path, path, type: "file" });
  }, [active, openFile, openFileTarget, connection.bindingId]);
  const add = async (item: WorkspaceEntry) => {
    try {
      await onAdd(item);
      setError("");
    } catch (error) {
      setError(String(error));
    }
  };
  const navigate = (path: string) => {
    fileRequest.current?.abort();
    onRoot(path);
    setSearch("");
    setFile(null);
    setEditingPath(false);
    setLocation(null);
  };
  return (
    <div className="files-panel">
      <div className="tool-subbar file-navigation">
        <IconButton
          label={tr("上一级目录")}
          disabled={!listing || listing.path === listing.parent}
          onClick={() => {
            if (listing) navigate(listing.parent);
          }}
        >
          <IconArrowUp />
        </IconButton>
        <div className="file-navigation-location">
          <FileSource
            key={`${connection.bindingId}:${active}`}
            path={file?.path || listing?.path || root}
            preview={Boolean(file)}
            workspacePath={workspacePath}
            onNavigate={navigate}
          />
          <button
            className="file-location"
            ref={pathTrigger}
            type="button"
            draggable={Boolean(listing)}
            onDragStart={(event) => {
              if (!listing) return;
              event.dataTransfer.setData(
                LOCAL_RESOURCE_MIME,
                JSON.stringify({ name: listing.name, path: listing.path, type: "directory" }),
              );
              event.dataTransfer.effectAllowed = "copy";
            }}
            title={listing?.path || root}
            aria-label={tr("输入目录路径")}
            aria-expanded={editingPath}
            onClick={() => {
              setLocation(null);
              setEditingPath(!editingPath);
            }}
          >
            <span>
              {root === "~"
                ? tr("用户主目录")
                : listing?.path === workspacePath
                  ? tr("画布工作目录")
                  : listing?.name || tr("服务器目录")}
            </span>
          </button>
        </div>
        <IconButton label={tr("刷新文件树")} onClick={() => setRevision(revision + 1)}>
          <IconRefresh />
        </IconButton>
        <IconButton
          label={tr("添加当前目录到画布")}
          disabled={!listing}
          onClick={() => {
            if (listing) void add({ name: listing.name, path: listing.path, type: "directory" });
          }}
        >
          <IconPlus />
        </IconButton>
      </div>
      <DownloadStatus download={download} />
      {editingPath && (
        <form
          className="file-path-form"
          onSubmit={(event) => {
            event.preventDefault();
            navigate(location ?? listing?.path ?? root);
            pathTrigger.current?.focus();
          }}
        >
          <input
            ref={pathInput}
            aria-label={tr("服务器目录路径")}
            value={location ?? listing?.path ?? root}
            onChange={(event) => setLocation(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              event.stopPropagation();
              setEditingPath(false);
              setLocation(null);
              pathTrigger.current?.focus();
            }}
          />
          <Button type="submit">{tr("打开目录")}</Button>
        </form>
      )}
      <input
        className="file-search"
        aria-label={tr("搜索目录树")}
        placeholder={tr("搜索此目录中的文件\u2026")}
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      {error && (
        <p className="workspace-error" role="alert">
          {error}
        </p>
      )}
      {!file && (
        <div className="file-tree-scroll panel-scroll">
          {!listing && !error && (
            <p className="tree-status" role="status">
              {tr("读取目录\u2026")}
            </p>
          )}
          <ul
            className="local-file-tree"
            aria-label={tr("服务器目录树")}
            key={`${root}:${search}:${revision}`}
          >
            {listing?.entries.map((item) => (
              <TreeEntry
                key={item.path}
                item={item}
                onOpen={(item) => void openFile(item)}
                onDownload={(item) => void download.start({ path: item.path, name: item.name })}
                downloading={download.busy}
                onAdd={(item) => void add(item)}
              />
            ))}
          </ul>
          {listing?.truncated && (
            <p className="tree-status">{tr("结果已限制，请缩小搜索范围。")}</p>
          )}
          {listing && !listing.entries.length && (
            <p className="tree-status">{search ? tr("没有匹配的文件") : tr("空目录")}</p>
          )}
        </div>
      )}
      {file && (
        <div className="file-preview file-preview-full">
          <div className="tool-subbar">
            <IconButton label={tr("返回目录")} onClick={() => setFile(null)}>
              <IconArrowUp size={16} />
            </IconButton>
            <span className="file-location">{file.name}</span>
            <Button
              type="button"
              disabled={download.busy}
              onClick={() => void download.start(file)}
            >
              {tr("下载到此设备")}
            </Button>
            {file.data && file.mime.startsWith("image/") && (
              <Button type="button" onClick={() => void copyImage()}>
                {file.mime === "image/gif" ? tr("复制静态帧") : tr("复制图片")}
              </Button>
            )}
            <IconButton
              label={tr("添加文件到画布")}
              onClick={() => void add({ name: file.name, path: file.path, type: "file" })}
            >
              <IconPlus />
            </IconButton>
            <IconButton label={tr("关闭文件预览")} onClick={() => setFile(null)}>
              <IconClose />
            </IconButton>
          </div>
          <div className="panel-scroll">
            {fileAction && <p role="status">{fileAction}</p>}
            <FilePreview
              key={file.path}
              file={file}
              imageRef={image}
              origin={{ kind: "workspace", id: "files", filePath: file.path }}
              onDownload={() => void download.start(file)}
              busy={download.busy}
            />
          </div>
        </div>
      )}
    </div>
  );
}
