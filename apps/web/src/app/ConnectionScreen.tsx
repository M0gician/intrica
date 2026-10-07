import { useTranslation } from "../i18n";
import { Button } from "../ui/button";
import { Input } from "../ui/field";
import type { useServerConnection } from "./use-server-connection";

type Props = { connection: ReturnType<typeof useServerConnection>; onSettings: () => void };
export function ConnectionScreen({ connection, onSettings }: Props) {
  const { t } = useTranslation();
  const { phase, error, token, setToken, connect, login } = connection;
  return (
    <main className="remote-login">
      <h1>
        {t(
          phase === "loading"
            ? "connecting"
            : phase === "login"
              ? "signIn"
              : phase === "disconnected"
                ? "disconnected"
                : "connectionFailed",
        )}
      </h1>
      {phase === "login" && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void login();
          }}
        >
          <p>{t("tokenHint")}</p>
          <Input
            aria-label={t("accessToken")}
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
          <Button type="submit">{t("connect")}</Button>
        </form>
      )}
      {error && <p role="alert">{error}</p>}
      {phase === "error" && connection.binding.address && (
        <Button onClick={() => void connect()}>{t("reconnect")}</Button>
      )}
      <Button onClick={onSettings}>{t("settings")}</Button>
    </main>
  );
}
