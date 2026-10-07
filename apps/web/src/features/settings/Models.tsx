import type { ModelDirectory, ModelEndpointView, ModelProfileView } from "@intrica/contracts";
import { useEffect, useState } from "react";
import { useSessionConnection } from "../../api/connection";
import { useModels } from "../../data/models";
import { useTranslation } from "../../i18n";
import { Button } from "../../ui/button";
import { Dialog } from "../../ui/dialog";
import { Select } from "../../ui/field";
import { EndpointEditor } from "./EndpointEditor";
import { ModelEditor } from "./ModelEditor";
import { SettingsMenu } from "./SettingsMenu";
import { type DraftRegistration, Notice, settingsError } from "./shared";

type Props = {
  register: DraftRegistration;
  navigate: (action: () => void) => void;
};
export function Models({ register, navigate }: Props) {
  const { t } = useTranslation(),
    { transport, serverRequest } = useSessionConnection(),
    models = useModels();
  const [editing, setEditing] = useState<
    | {
        kind: "endpoint";
        value?: ModelEndpointView;
      }
    | {
        kind: "model";
        endpointId: string;
        value?: ModelProfileView;
      }
    | null
  >(null);
  const [deleting, setDeleting] = useState<{
      kind: "endpoint" | "model";
      id: string;
      revision: number;
    } | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const leave = () => setEditing(null);
  useEffect(() => {
    if (!editing) register(false, undefined, busy);
  }, [editing, busy, register]);
  const remove = async () => {
    if (!deleting) return;
    setBusy(true);
    setError("");
    try {
      const data =
        deleting.kind === "endpoint"
          ? await transport.json<ModelDirectory>(
              "DELETE",
              `/api/v2/model-endpoints/${encodeURIComponent(deleting.id)}?expectedRevision=${deleting.revision}`,
            )
          : await serverRequest<ModelDirectory>(
              `models/${encodeURIComponent(deleting.id)}?expectedRevision=${deleting.revision}`,
              undefined,
              "DELETE",
            );
      models.update(data);
      setDeleting(null);
      setError("");
    } catch (e) {
      setError(settingsError(e));
    } finally {
      setBusy(false);
    }
  };
  const selection = async (id: string | null) => {
    setBusy(true);
    setError("");
    try {
      await models.select(id);
    } catch (e) {
      setError(settingsError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Notice error={deleting ? "" : error || models.error} />
      <div className="settings-row">
        <label htmlFor="default-model">{t("defaultModel")}</label>
        <Select
          id="default-model"
          disabled={busy}
          value={models.data?.selectedId ?? ""}
          onChange={(event) => void selection(event.target.value || null)}
        >
          <option value="">{t("notConfigured")}</option>
          {models.data?.profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name}
            </option>
          ))}
        </Select>
      </div>
      <div className="settings-section-heading">
        <h3>{t("apiEndpoints")}</h3>
        <Button onClick={() => setEditing({ kind: "endpoint" })} disabled={busy}>
          {t("addEndpoint")}
        </Button>
      </div>
      <div className="settings-endpoints">
        {models.data?.endpoints.map((endpoint) => (
          <section className="settings-endpoint" key={endpoint.id}>
            <header className="model-endpoint-header">
              <div>
                <h3>{endpoint.name}</h3>
                <span className="settings-url">{endpoint.baseUrl}</span>
              </div>
              <SettingsMenu
                label={t("manageEndpoint", { name: endpoint.name })}
                disabled={busy}
                actions={[
                  {
                    label: t("editEndpoint"),
                    action: () => setEditing({ kind: "endpoint", value: endpoint }),
                  },
                  {
                    label: t("delete"),
                    danger: true,
                    action: () =>
                      setDeleting({
                        kind: "endpoint",
                        id: endpoint.id,
                        revision: endpoint.revision,
                      }),
                  },
                ]}
              />
            </header>
            <ul className="settings-model-list">
              {models
                .data!.profiles.filter((profile) => profile.endpointId === endpoint.id)
                .map((profile) => (
                  <li key={profile.id}>
                    <Button
                      variant="quiet"
                      className="model-row-label"
                      disabled={busy}
                      onClick={() =>
                        setEditing({ kind: "model", endpointId: endpoint.id, value: profile })
                      }
                    >
                      <strong>{profile.name}</strong>
                      <span>{profile.modelId}</span>
                    </Button>
                    {models.data?.selectedId === profile.id && (
                      <span className="model-default">{t("defaultLabel")}</span>
                    )}
                    <SettingsMenu
                      label={t("manageModel", { name: profile.name })}
                      disabled={busy}
                      actions={[
                        { label: t("setDefault"), action: () => void selection(profile.id) },
                        {
                          label: t("delete"),
                          danger: true,
                          action: () =>
                            setDeleting({
                              kind: "model",
                              id: profile.id,
                              revision: profile.revision!,
                            }),
                        },
                      ]}
                    />
                  </li>
                ))}
            </ul>
            <Button
              className="endpoint-add-model"
              variant="quiet"
              disabled={busy}
              onClick={() => setEditing({ kind: "model", endpointId: endpoint.id })}
            >
              {t("addModel")}
            </Button>
          </section>
        ))}
      </div>
      {editing?.kind === "endpoint" && (
        <Dialog
          className="settings-editor"
          label={t(editing.value ? "editEndpoint" : "addEndpoint")}
          onClose={() => navigate(leave)}
        >
          <EndpointEditor
            key={editing.value?.id ?? "new"}
            endpoint={editing.value}
            register={register}
            onSaved={(data) => {
              models.update(data);
              leave();
            }}
            onCancel={() => navigate(leave)}
          />
        </Dialog>
      )}
      {editing?.kind === "model" && (
        <Dialog
          className="settings-editor"
          label={t(editing.value ? "editModel" : "addModel")}
          onClose={() => navigate(leave)}
        >
          <ModelEditor
            key={editing.value?.id ?? "new"}
            endpointId={editing.endpointId}
            profile={editing.value}
            register={register}
            onSaved={(data) => {
              models.update(data);
              leave();
            }}
            onCancel={() => navigate(leave)}
          />
        </Dialog>
      )}
      {deleting && (
        <Dialog
          className="settings-editor"
          role="alertdialog"
          label={t("delete")}
          onClose={() => {
            if (!busy) setDeleting(null);
          }}
        >
          <h3>{t("delete")}</h3>
          <Notice error={error} />
          <p>
            {deleting.kind === "endpoint"
              ? t("deleteEndpointHint", {
                  count:
                    models.data?.profiles.filter((p) => p.endpointId === deleting.id).length ?? 0,
                })
              : t("deleteModelHint")}
          </p>
          {(deleting.id === models.data?.selectedId ||
            models.data?.profiles.some(
              (p) => p.id === models.data?.selectedId && p.endpointId === deleting.id,
            )) && <p>{t("defaultRemoved")}</p>}
          <div className="settings-actions">
            <Button type="button" disabled={busy} onClick={() => setDeleting(null)}>
              {t("cancel")}
            </Button>
            <Button type="button" variant="danger" disabled={busy} onClick={() => void remove()}>
              {t("delete")}
            </Button>
          </div>
        </Dialog>
      )}
    </>
  );
}
