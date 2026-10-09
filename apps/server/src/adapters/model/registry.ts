import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ManagedModelInput,
  ModelDirectory,
  ModelEndpointInput,
  ModelProfileInput,
  ModelSelection,
} from "@intrica/contracts";
import { type Database, DomainError, id, type Sql, type Tx } from "../postgres/database.js";
import { modelCapabilities } from "./model-catalog.js";
import { initialModelProfile, normalizeModelProfile } from "./model-settings.js";
import type { ModelConfig } from "./types.js";

export type FrozenModel = {
  config: ModelConfig;
  credentialRef?: string;
  endpointId?: string;
  profileId?: string;
};
const conflict = () =>
  new DomainError("VERSION_CONFLICT", "Configuration changed; reload before saving");
export class ModelRegistry {
  constructor(
    readonly db: Database,
    readonly dataDir: string,
    /** Trusted programmatic test injection; never loaded from HTTP or environment. */
    readonly fallback: ModelConfig | null,
  ) {}
  async secret(value: string): Promise<string> {
    const key = createHash("sha256").update(value).digest("hex");
    const dir = join(this.dataDir, "secrets");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(join(dir, key), value, { mode: 0o600, flag: "wx" }).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
    return key;
  }
  private edit<T>(action: (tx: Tx) => Promise<T>) {
    return this.db.transaction(async (tx) => {
      await tx.query("select pg_advisory_xact_lock(hashtextextended('intrica-model-profiles',0))");
      const value = await action(tx);
      await tx.query(
        "update conversations set context=context-'modelBlocked' where context->>'modelBlocked'='true'",
      );
      // A configuration edit wakes only schedules blocked for missing configuration.
      await tx.query(
        "update schedules set enabled=true,spec=spec-'blockedReason',next_due_at=now() where spec->>'blockedReason'='model_not_configured'",
      );
      return value;
    });
  }
  async initialize() {
    await this.edit(async (tx) => {
      await tx.query(
        "update agent_configs set config=config-'model' where config->'model'->>'profileId' in (select id from model_profiles where public_config->>'kind'='mock')",
      );
      await tx.query(
        "update conversations set model=null where model->>'profileId' in (select id from model_profiles where public_config->>'kind'='mock')",
      );
      await tx.query("delete from model_profiles where public_config->>'kind'='mock'");
      if (this.fallback?.kind !== "mock")
        await tx.query(
          "update runs set cancel_requested_at=coalesce(cancel_requested_at,now()),reason='model_not_configured' where state in ('queued','running','waiting') and frozen_input->'model'->'config'->>'kind'='mock'",
        );
      if ((await tx.query("select models_initialized from schema_info")).rows[0].models_initialized)
        return;
      if (!(await tx.query("select id from model_profiles limit 1")).rowCount) {
        if (this.fallback?.kind === "pi") {
          for (const profile of [initialModelProfile(this.fallback)].filter((p) => p !== null)) {
            const { apiKey, baseUrl, id: profileId, ...config } = profile;
            await tx.query(
              "insert into model_endpoints(id,name,base_url,credential_ref) values($1,$2,$3,$4)",
              [profileId, "Startup endpoint", baseUrl, apiKey ? await this.secret(apiKey) : ""],
            );
            await tx.query(
              "insert into model_profiles(id,endpoint_id,public_config,selected) values($1,$1,$2,true)",
              [profileId, JSON.stringify(config)],
            );
          }
        }
      }
      await tx.query("update schema_info set models_initialized=true");
    });
  }
  private rows(sql: Sql = this.db.pool) {
    return sql.query(
      "select p.*,e.base_url,e.credential_ref from model_profiles p left join model_endpoints e on e.id=p.endpoint_id order by p.id",
    );
  }
  async view(sql?: Sql): Promise<ModelDirectory> {
    if (!sql) return this.db.transaction((tx) => this.view(tx), true);
    const { rows } = await this.rows(sql);
    const endpoints = (
      await sql.query(
        "select id,name,base_url,revision,credential_ref<>'' as has_key from model_endpoints order by name,id",
      )
    ).rows.map((e) => ({
      id: e.id,
      name: e.name,
      baseUrl: e.base_url,
      revision: e.revision,
      hasKey: e.has_key,
    }));
    const profiles = rows
      .filter((r) => r.public_config.kind !== "mock" && r.endpoint_id && r.base_url)
      .map((r) => ({
        ...r.public_config,
        id: r.id,
        endpointId: r.endpoint_id,
        revision: r.version,
        thinkingLevels: modelCapabilities({ ...r.public_config, kind: "pi", baseUrl: r.base_url })
          .thinkingLevels,
      }));
    const active = profiles.find((p) => rows.find((r) => r.id === p.id)?.selected);
    return {
      endpoints,
      profiles,
      selectedId: active?.id ?? null,
      active: active
        ? {
            name: active.name,
            modelId: active.modelId,
            thinkingLevel: active.thinkingLevel,
            thinkingLevels: active.thinkingLevels,
          }
        : { name: "Not configured", modelId: "", thinkingLevel: "off", thinkingLevels: ["off"] },
    };
  }
  async capture(selection?: ModelSelection | null): Promise<FrozenModel> {
    const r = (
      await this.db.pool.query(
        "select p.*,e.base_url,e.credential_ref from model_profiles p left join model_endpoints e on e.id=p.endpoint_id where ($1::text is null and p.selected) or p.id=$1",
        [selection?.profileId ?? null],
      )
    ).rows[0];
    if (!r && !selection?.profileId && this.fallback?.kind === "mock")
      return { config: this.fallback };
    if (
      !r ||
      r.public_config.kind === "mock" ||
      !r.endpoint_id ||
      !r.base_url ||
      !r.public_config.modelId?.trim()
    )
      throw new DomainError(
        "MODEL_NOT_CONFIGURED",
        "Select a configured model before starting work",
      );
    const config: ModelConfig = {
      ...r.public_config,
      kind: "pi",
      baseUrl: r.base_url,
      ...(selection?.thinkingLevel ? { thinkingLevel: selection.thinkingLevel } : {}),
    };
    try {
      normalizeModelProfile({ ...r.public_config, baseUrl: r.base_url, apiKey: "" });
      modelCapabilities(config);
    } catch {
      throw new DomainError(
        "MODEL_NOT_CONFIGURED",
        "The selected model configuration is invalid; edit the endpoint and model",
      );
    }
    return { config, credentialRef: r.credential_ref, endpointId: r.endpoint_id, profileId: r.id };
  }
  async resolve(selection?: ModelSelection | null) {
    return this.materialize(await this.capture(selection));
  }
  async materialize(frozen: FrozenModel): Promise<ModelConfig> {
    if (frozen.config.kind === "mock") {
      if (this.fallback?.kind === "mock") return frozen.config;
      throw new DomainError(
        "MODEL_NOT_CONFIGURED",
        "Add an endpoint and model before starting work",
      );
    }
    if (frozen.credentialRef && !/^[a-f0-9]{64}$/.test(frozen.credentialRef))
      throw new DomainError("VALIDATION", "Invalid credential reference");
    return {
      ...frozen.config,
      apiKey: frozen.credentialRef
        ? await readFile(join(this.dataDir, "secrets", frozen.credentialRef), "utf8")
        : "intrica-keyless",
    };
  }
  async saveEndpoint(input: ModelEndpointInput) {
    let url: URL;
    try {
      url = new URL(input.baseUrl.trim());
    } catch {
      throw new DomainError("VALIDATION", "Invalid endpoint URL");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !input.name.trim()
    )
      throw new DomainError("VALIDATION", "Invalid endpoint URL or name");
    const baseUrl = url.href.replace(/\/+$/, "");
    return this.edit(async (tx) => {
      const old = input.id
        ? (await tx.query("select * from model_endpoints where id=$1", [input.id])).rows[0]
        : null;
      if (input.id && (!old || old.revision !== input.expectedRevision)) throw conflict();
      if (old && old.base_url !== baseUrl && input.apiKey === undefined)
        throw new DomainError(
          "VALIDATION",
          "Changing endpoint URL requires a new key or explicit key removal",
        );
      const ref =
        input.apiKey === undefined
          ? (old?.credential_ref ?? "")
          : input.apiKey
            ? await this.secret(input.apiKey)
            : "";
      const endpointId = input.id ?? id("endpoint");
      await tx.query(
        "insert into model_endpoints(id,name,base_url,credential_ref) values($1,$2,$3,$4) on conflict(id) do update set name=excluded.name,base_url=excluded.base_url,credential_ref=excluded.credential_ref,revision=model_endpoints.revision+1",
        [endpointId, input.name.trim(), baseUrl, ref],
      );
      return { ...(await this.view(tx)), savedId: endpointId };
    });
  }
  async deleteEndpoint(endpointId: string, expectedRevision: number) {
    return this.edit(async (tx) => {
      const deleted = await tx.query(
        "delete from model_endpoints where id=$1 and revision=$2 returning id",
        [endpointId, expectedRevision],
      );
      if (!deleted.rowCount) throw conflict();
      return this.view(tx);
    });
  }
  private async prepare(input: ManagedModelInput, sql: Sql = this.db.pool) {
    const endpoint = (
      await sql.query("select * from model_endpoints where id=$1", [input.endpointId])
    ).rows[0];
    if (!endpoint) throw new DomainError("NOT_FOUND", "Endpoint no longer exists");
    const { id: _id, expectedRevision: _rev, endpointId: _endpoint, ...fields } = input;
    const prepared = normalizeModelProfile({ ...fields, baseUrl: endpoint.base_url, apiKey: "" });
    const { id: _generated, baseUrl: _url, apiKey: _key, ...config } = prepared;
    return { endpoint, config };
  }
  async save(input: ManagedModelInput) {
    return this.edit(async (tx) => {
      const { config } = await this.prepare(input, tx);
      const profileId = input.id ?? id("model");
      if (input.id) {
        const changed = await tx.query(
          "update model_profiles set public_config=$2,endpoint_id=$3,version=version+1 where id=$1 and version=$4 and endpoint_id is not null returning id",
          [profileId, JSON.stringify(config), input.endpointId, input.expectedRevision],
        );
        if (!changed.rowCount) throw conflict();
      } else
        await tx.query(
          "insert into model_profiles(id,endpoint_id,public_config) values($1,$2,$3)",
          [profileId, input.endpointId, JSON.stringify(config)],
        );
      return { ...(await this.view(tx)), savedId: profileId };
    });
  }
  async select(profileId: string | null, expectedSelectedId: string | null) {
    return this.edit(async (tx) => {
      const current =
        (await tx.query("select id from model_profiles where selected")).rows[0]?.id ?? null;
      if (current !== expectedSelectedId) throw conflict();
      if (
        profileId &&
        !(
          await tx.query(
            "select id from model_profiles where id=$1 and endpoint_id is not null and public_config->>'kind' is distinct from 'mock'",
            [profileId],
          )
        ).rowCount
      )
        throw new DomainError("NOT_FOUND", "Model no longer exists");
      await tx.query("update model_profiles set selected=false where selected");
      if (profileId)
        await tx.query("update model_profiles set selected=true where id=$1", [profileId]);
      return this.view(tx);
    });
  }
  async delete(profileId: string, expectedRevision: number) {
    return this.edit(async (tx) => {
      if (
        !(
          await tx.query("delete from model_profiles where id=$1 and version=$2 returning id", [
            profileId,
            expectedRevision,
          ])
        ).rowCount
      )
        throw conflict();
      return this.view(tx);
    });
  }
  async testConfig(input: ManagedModelInput): Promise<ModelConfig> {
    const { config, endpoint } = await this.prepare(input);
    return this.materialize({
      config: { kind: "pi", ...config, baseUrl: endpoint.base_url },
      credentialRef: endpoint.credential_ref,
    });
  }
  async connection(input: { endpointId: string; api: ModelProfileInput["api"]; provider: string }) {
    const config = await this.testConfig({
      ...input,
      name: "Connection check",
      modelId: "connection-check",
      reasoning: false,
      supportsVision: false,
      thinkingLevel: "off",
    });
    if (config.kind !== "pi") throw new DomainError("VALIDATION", "Invalid endpoint model");
    return config;
  }
}
