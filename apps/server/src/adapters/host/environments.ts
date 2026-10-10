import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { DomainError, digest, id, type Sql } from "../postgres/database.js";
import { hostCapabilities } from "./capabilities.js";
import type { HostExecutor } from "./executor.js";
import { canonicalPath, isolationAvailable, withinPath } from "./sandbox.js";

export type EnvironmentOwner = { canvasId: string; agentId: string | null };
export type EnvironmentSpec = {
  label: string;
  interpreter: string;
  cwd: string;
  instructions: string;
};

/** Describes a known runtime. Registration and sharing never create a grant. */
export class EnvironmentRegistry {
  constructor(readonly host: HostExecutor) {}
  async verify(
    owner: EnvironmentOwner,
    spec: Pick<EnvironmentSpec, "interpreter" | "cwd">,
    sql: Sql = this.host.db.pool,
  ) {
    const interpreter = await canonicalPath(spec.interpreter),
      cwd = await canonicalPath(spec.cwd);
    if (interpreter !== spec.interpreter || cwd !== spec.cwd)
      throw new DomainError("TARGET_CHANGED", "环境路径已变化，请重新登记");
    if ((await this.host.protectedPath(cwd)) || (await this.host.protectedPath(interpreter)))
      throw new DomainError("FORBIDDEN", "环境不能使用服务端管理目录");
    let executionMode = "host";
    if (owner.agentId) {
      const scope = await this.host.scope({ agentId: owner.agentId }, cwd, sql);
      await this.host.assertPath({ agentId: owner.agentId }, cwd, false, sql);
      if (scope.identity.canvas_id !== owner.canvasId)
        throw new DomainError("FORBIDDEN", "环境不属于此画布");
      if (scope.identity.config.role !== "admin" && !scope.commandRoots.length) {
        if (
          !scope.isolatedRoots.some((root) => withinPath(root, cwd)) ||
          !(await isolationAvailable())
        )
          throw new DomainError("FORBIDDEN", "当前没有可用的环境执行权限");
        executionMode = "isolated";
      }
      const system = (await hostCapabilities()).commands.some((c) => c.path === interpreter);
      if (!system) await this.host.assertPath({ agentId: owner.agentId }, interpreter, false, sql);
    }
    const [binary, directory] = await Promise.all([stat(interpreter), stat(cwd)]).catch(() => {
      throw new DomainError(
        "ENVIRONMENT_UNAVAILABLE",
        "环境的解释器或工作目录已不可用，请重新检查环境",
      );
    });
    if (!binary.isFile() || !directory.isDirectory())
      throw new DomainError("VALIDATION", "环境需要可执行文件和工作目录");
    await access(interpreter, constants.X_OK).catch(() => {
      throw new DomainError("ENVIRONMENT_UNAVAILABLE", "环境解释器已不可执行");
    });
    const verification = {
      interpreter: {
        path: interpreter,
        device: binary.dev,
        inode: binary.ino,
        bytes: binary.size,
        modified: binary.mtimeMs,
        changed: binary.ctimeMs,
      },
      directory: { path: cwd, device: directory.dev, inode: directory.ino },
      runtimeVersion: interpreter === process.execPath ? process.version : null,
    };
    return { verification, fingerprint: digest(verification), executionMode };
  }
  async register(sql: Sql, owner: EnvironmentOwner, spec: EnvironmentSpec) {
    const checked = await this.verify(owner, spec, sql);
    const row = (
      await sql.query(
        `insert into execution_environments(id,canvas_id,creator_agent_id,label,interpreter,cwd,instructions,fingerprint,verification)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
        [
          id("environment"),
          owner.canvasId,
          owner.agentId,
          spec.label,
          spec.interpreter,
          spec.cwd,
          spec.instructions,
          checked.fingerprint,
          JSON.stringify(checked.verification),
        ],
      )
    ).rows[0];
    return {
      id: row.id,
      version: checked.fingerprint,
      ...spec,
      executionMode: checked.executionMode,
      verification: checked.verification,
      grantsAccess: false,
    };
  }
  async list(owner: EnvironmentOwner, sql: Sql = this.host.db.pool) {
    return (
      await sql.query(
        `select id,label,interpreter,cwd,instructions,fingerprint as version,verification,created_at
      from execution_environments where canvas_id=$1 order by created_at desc,id limit 100`,
        [owner.canvasId],
      )
    ).rows;
  }
  async resolve(
    owner: EnvironmentOwner,
    reference: { id: string; version: string },
    sql: Sql = this.host.db.pool,
  ) {
    const row = (
      await sql.query("select * from execution_environments where id=$1 and canvas_id=$2", [
        reference.id,
        owner.canvasId,
      ])
    ).rows[0];
    if (!row) throw new DomainError("NOT_FOUND", "环境引用不存在或属于其他画布");
    if (row.fingerprint !== reference.version)
      throw new DomainError("VERSION_CONFLICT", "环境引用版本不匹配");
    const checked = await this.verify(owner, row, sql);
    if (checked.fingerprint !== row.fingerprint)
      throw new DomainError(
        "ENVIRONMENT_CHANGED",
        "环境的可执行文件或目录已变化，请核实并重新登记",
      );
    return {
      id: row.id,
      version: row.fingerprint,
      label: row.label,
      interpreter: row.interpreter,
      cwd: row.cwd,
      instructions: row.instructions,
      executionMode: checked.executionMode,
      grantsAccess: false,
    };
  }
}
