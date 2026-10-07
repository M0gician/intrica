import type { ServerVersion, UpdateCheck } from "@intrica/contracts";
import { useTranslation } from "../../i18n";
export function ServerUpdateInstructions({
  server,
  check,
}: {
  server: ServerVersion;
  check: UpdateCheck;
}) {
  const { t } = useTranslation();
  return (
    <details className="update-details">
      <summary>{t("更新步骤", { ns: "ui" })}</summary>
      <p>{t("serverUpgradeHint")}</p>
      {check.release.apiVersion !== server.apiVersion && <p>{t("protocolUpdateHint")}</p>}
      {server.deployment === "container" ? (
        <>
          <p>{t("containerUpdateHint")}</p>
          <pre className="settings-update-command">INTRICA_IMAGE={check.release.serverImage}</pre>
          <pre className="settings-update-command">
            {
              "docker compose -f compose.release.yaml pull intrica\ndocker compose -f compose.release.yaml up -d --no-deps --wait intrica"
            }
          </pre>
        </>
      ) : server.deployment === "service" ? (
        <>
          <p>{t("serviceUpdateHint")}</p>
          <pre className="settings-update-command">{`curl -q --fail --location --proto '=https' --proto-redir '=https' https://github.com/M0gician/intrica/releases/download/v${check.release.version}/install-server.sh -o install-server.sh\nbash install-server.sh v${check.release.version}`}</pre>
        </>
      ) : (
        <>
          <p>{t("sourceUpdateHint")}</p>
          <pre className="settings-update-command">{`git fetch origin tag v${check.release.version}\ngit checkout --detach v${check.release.version}\npnpm install --frozen-lockfile\npnpm web:prepare`}</pre>
        </>
      )}
    </details>
  );
}
