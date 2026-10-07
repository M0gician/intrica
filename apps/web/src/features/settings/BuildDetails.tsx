import type { BuildIdentity } from "@intrica/contracts";
import { useState } from "react";
import { date, useTranslation } from "../../i18n";
import { Button } from "../../ui/button";

/** Diagnostics are an allowlist, never a dump of connection/settings state. */
export function BuildDetails({ build }: { build: BuildIdentity }) {
  const { t } = useTranslation();
  const [copy, setCopy] = useState<"done" | "failed" | null>(null);
  return (
    <details className="build-details">
      <summary>{t("构建信息", { ns: "ui" })}</summary>
      <dl className="build-identity">
        <dt>{t("buildVersion")}</dt>
        <dd>{build.version}</dd>
        <dt>{t("buildChannel")}</dt>
        <dd>{t(`buildChannel_${build.channel}`)}</dd>
        <dt>{t("buildId")}</dt>
        <dd>{build.buildId ?? t("buildUnknown")}</dd>
        <dt>{t("buildTime")}</dt>
        <dd>{build.builtAt ? date(build.builtAt) : t("buildUnknown")}</dd>
      </dl>
      <Button
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(
              JSON.stringify(
                {
                  version: build.version,
                  channel: build.channel,
                  buildId: build.buildId,
                  commit: build.commit,
                  builtAt: build.builtAt,
                },
                null,
                2,
              ),
            );
            setCopy("done");
          } catch {
            setCopy("failed");
          }
        }}
      >
        {t("copyBuildDiagnostics")}
      </Button>
      {copy && <p role="status">{t(copy === "done" ? "buildCopied" : "buildCopyFailed")}</p>}
    </details>
  );
}
