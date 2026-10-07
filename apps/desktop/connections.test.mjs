import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createConnections } from "./connections.mjs";

test("fixed server bindings preserve streaming and reject stale routes, redirects and identity changes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "intrica-connections-"));
  const fixtures = [];
  const writes = [];
  let identityB = "server-b";
  const start = async (id, token) => {
    const server = createServer(async (req, res) => {
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401).end();
        return;
      }
      if (req.url === "/api/v2/session") {
        res.setHeader("content-type", "application/json");
        res.end('{"authenticated":true}');
        return;
      }
      if (req.url === "/api/v2/server") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ id: id === "b" ? identityB : "server-a", apiVersion: "v2" }));
        return;
      }
      if (req.url === "/api/v2/redirect") {
        res.writeHead(302, { location: "http://127.0.0.1:1/api/v2/stolen" }).end();
        return;
      }
      if (req.method === "POST") {
        let data = "";
        for await (const chunk of req) data += chunk;
        writes.push({ id, data, language: req.headers["accept-language"] });
      }
      res.setHeader("content-type", "application/x-ndjson");
      res.setHeader("content-disposition", "attachment; filename=fixture.bin");
      res.write('{"seq":"1"}\n');
      setTimeout(() => res.end('{"seq":"2"}\n'), 10);
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    fixtures.push(server);
    return `http://127.0.0.1:${server.address().port}`;
  };
  const a = await start("a", "token-a"),
    b = await start("b", "token-b");
  const safeStorage = {
    isEncryptionAvailable: () => false,
    getSelectedStorageBackend: () => "basic_text",
  };
  const connections = await createConnections({
    userData: dir,
    safeStorage,
    localUrl: a,
    localToken: "token-a",
  });
  try {
    const first = await connections.activate("local");
    await assert.rejects(connections.save({ label: "B", baseUrl: b, token: "incorrect" }));
    assert.equal(connections.get().bindingId, first.bindingId);
    const profile = await connections.save({ label: "B", baseUrl: b, token: "token-b" });
    const updated = await connections.save({ id: profile.id, label: "B renamed", baseUrl: b });
    assert.equal(updated.id, profile.id);
    assert.equal(updated.label, "B renamed");
    assert.equal(connections.list().length, 2);
    assert.equal(profile.persistent, false);
    assert.ok(!(await readFile(join(dir, "connections.json"), "utf8")).includes("token-b"));
    const response = await connections.forward(
      new Request("intrica://app/api/v2/write", {
        method: "POST",
        body: '{"value":1}',
        headers: { "accept-language": "zh-CN" },
      }),
      first.bindingId,
      "/api/v2/write",
    );
    assert.equal(await response.text(), '{"seq":"1"}\n{"seq":"2"}\n');
    assert.equal(response.headers.get("content-disposition"), "attachment; filename=fixture.bin");
    assert.deepEqual(writes, [{ id: "a", data: '{"value":1}', language: "zh-CN" }]);
    const second = await connections.activate(profile.id);
    assert.notEqual(first.bindingId, second.bindingId);
    assert.equal(
      (
        await connections.forward(
          new Request("intrica://app/api/v2/write", { method: "POST", body: "late" }),
          first.bindingId,
          "/api/v2/write",
        )
      ).status,
      410,
    );
    assert.equal(
      (
        await connections.forward(
          new Request("intrica://app/api/v2/redirect"),
          second.bindingId,
          "/api/v2/redirect",
        )
      ).status,
      502,
    );
    assert.equal(writes.length, 1);
    identityB = "replacement";
    await assert.rejects(connections.activate(profile.id), /serverChanged/);
    assert.equal(connections.get().bindingId, second.bindingId);
    await assert.rejects(
      connections.save({ label: "bad", baseUrl: "file:///tmp/server", token: "x" }),
    );
    await connections.activate("local");
    await connections.remove(profile.id);
    assert.equal(connections.list().length, 1);
    let keychainProbes = 0;
    const protectedStorage = {
      isEncryptionAvailable: () => {
        keychainProbes++;
        return true;
      },
      encryptString: (value) => Buffer.from(`encrypted:${value}`),
      decryptString: (value) => value.toString().replace(/^encrypted:/, ""),
    };
    const encryptedDir = join(dir, "encrypted");
    let saved = await createConnections({
      userData: encryptedDir,
      safeStorage: protectedStorage,
      localUrl: a,
      localToken: "token-a",
    });
    const remembered = await saved.save({ label: "Remembered", baseUrl: b, token: "token-b" });
    saved.close();
    keychainProbes = 0;
    saved = await createConnections({
      userData: encryptedDir,
      safeStorage: protectedStorage,
      localUrl: a,
      localToken: "token-a",
    });
    assert.equal(keychainProbes, 0, "listing saved servers must not unlock the Keychain");
    assert.equal(saved.list().find((r) => r.id === remembered.id).hasToken, true);
    await saved.activate(remembered.id);
    assert.equal(keychainProbes, 1);
    keychainProbes = 0;
    const transient = await saved.save({
      id: remembered.id,
      label: "Session",
      baseUrl: b,
      token: "token-b",
      rememberToken: false,
    });
    assert.equal(keychainProbes, 0);
    assert.equal(transient.persistent, false);
    assert.ok(
      !(await readFile(join(encryptedDir, "connections.json"), "utf8")).includes("encryptedToken"),
    );
    const clearedBinding = await saved.activate(remembered.id);
    await saved.forgetToken(remembered.id);
    assert.equal(saved.list().find((r) => r.id === remembered.id).hasToken, false);
    assert.throws(() => saved.get(), /unavailable/);
    assert.equal(
      (
        await saved.forward(
          new Request("intrica://app/api/v2/server"),
          clearedBinding.bindingId,
          "/api/v2/server",
        )
      ).status,
      410,
    );
    await assert.rejects(saved.activate(remembered.id), /Authentication/);
    await assert.rejects(saved.forgetToken("local"), /cannot be cleared/);
    saved.close();
    const offline = await createConnections({
      userData: join(dir, "offline"),
      safeStorage,
    });
    try {
      assert.throws(() => offline.get(), /unavailable/);
      await assert.rejects(offline.activate("local"), /unavailable/);
      const remote = await offline.save({ label: "Remote", baseUrl: b, token: "token-b" });
      const binding = await offline.activate(remote.id);
      assert.equal(offline.get().profileId, remote.id);
      await offline.remove(remote.id);
      assert.throws(() => offline.get(), /unavailable/);
      assert.equal(
        (
          await offline.forward(
            new Request("intrica://app/api/v2/server"),
            binding.bindingId,
            "/api/v2/server",
          )
        ).status,
        410,
      );
    } finally {
      offline.close();
    }
  } finally {
    connections.close();
    await Promise.all(
      fixtures.map(
        (server) =>
          new Promise((r) => {
            server.closeAllConnections();
            server.close(r);
          }),
      ),
    );
    await rm(dir, { recursive: true, force: true });
  }
});

test("managed SSH connections persist alias, re-resolve tunnel and identity without exposing imported credentials", async () => {
  const dir = await mkdtemp(join(tmpdir(), "intrica-ssh-connections-"));
  const requests = [];
  const released = [];
  let port = 10001,
    identity = "ssh-server";
  const config = {
    userData: dir,
    safeStorage: {
      isEncryptionAvailable: () =>
        assert.fail("SSH-managed credentials must not unlock the Keychain"),
    },
    resolveSsh: async (alias) => {
      assert.equal(alias, "beta");
      return { baseUrl: `http://127.0.0.1:${port}`, token: "private-ssh-token" };
    },
    releaseSsh: (alias) => released.push(alias),
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return Response.json(url.endsWith("/server") ? { id: identity, apiVersion: "v2" } : {});
    },
  };
  let connections = await createConnections(config);
  try {
    const profile = await connections.saveManaged({
      alias: "beta",
      baseUrl: "http://127.0.0.1:10001",
      token: "private-ssh-token",
    });
    assert.equal(profile.sshAlias, "beta");
    assert.ok(!JSON.stringify(profile).includes("private-ssh-token"));
    assert.ok(
      !(await readFile(join(dir, "connections.json"), "utf8")).includes("private-ssh-token"),
    );
    connections.close();
    port = 10002;
    connections = await createConnections(config);
    const active = await connections.activate(profile.id);
    assert.equal(active.baseUrl, "http://127.0.0.1:10002");
    assert.equal(requests.at(-1).init.headers.Authorization, "Bearer private-ssh-token");
    await assert.rejects(
      connections.save({
        id: profile.id,
        label: "changed",
        baseUrl: "http://127.0.0.1:10003",
        token: "x",
      }),
      /through SSH deployment/,
    );
    identity = "different-server";
    await assert.rejects(connections.activate(profile.id), /serverChanged/);
    assert.equal(connections.get().bindingId, active.bindingId);
    await connections.remove(profile.id);
    assert.deepEqual(released, ["beta"]);
    await connections.remove(profile.id);
    assert.deepEqual(released, ["beta"], "removing an absent record must not close another relay");
  } finally {
    connections.close();
    await rm(dir, { recursive: true, force: true });
  }
});
