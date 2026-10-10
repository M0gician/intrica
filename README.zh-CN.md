<p align="center">
  <img src="apps/desktop/assets/icon.svg" width="88" alt="Intrica 标志">
</p>

<h1 align="center">Intrica</h1>
<p align="center">用于组织想法、资料和 AI Agent 的可视化工作区。</p>
<p align="center"><a href="README.md">English</a> · <strong>简体中文</strong></p>

将笔记、文件、图片、PDF、网页和待办放在同一画布，连接资料，分配 Agent 任务，并审查权限申请和执行结果。Intrica 在你的电脑或自托管服务器上运行。

## 安装

当前版本为 [v0.3.1](https://github.com/M0gician/intrica/releases/tag/v0.3.1)。下载安装包、检查更新和拉取容器镜像均无需 GitHub 账号、个人访问令牌或 GitHub CLI。桌面版自带 Node.js、PostgreSQL 和 Web 界面，无需单独安装这些组件。

| 平台 | 下载 | 安装方式 |
| --- | --- | --- |
| macOS，Apple Silicon | [DMG](https://github.com/M0gician/intrica/releases/download/v0.3.1/Intrica-0.3.1-mac-arm64.dmg) · [ZIP](https://github.com/M0gician/intrica/releases/download/v0.3.1/Intrica-0.3.1-mac-arm64.zip) | 将 `Intrica.app` 复制到“应用程序” |
| Linux x64，Debian/Ubuntu | [DEB](https://github.com/M0gician/intrica/releases/download/v0.3.1/Intrica-0.3.1-linux-amd64.deb) | 使用 `apt` 安装 |
| Linux x64，其他 glibc 发行版 | [AppImage](https://github.com/M0gician/intrica/releases/download/v0.3.1/Intrica-0.3.1-linux-x86_64.AppImage) | 添加执行权限后运行 |

Linux 发布检查使用 Ubuntu 22.04 x64。不提供 Windows、Intel Mac、Linux arm64 或 Alpine/musl 安装包。没有图形界面的 Linux x64 主机请使用[服务器安装方式](#服务器安装)。

### macOS

1. 下载并打开 DMG，将 `Intrica.app` 拖入“应用程序”。也可以解压 ZIP，再将 `Intrica.app` 移入“应用程序”。
2. 从“应用程序”打开 Intrica。**v0.3.1 使用临时签名（ad-hoc signing），未经 Apple 公证。** 如果 macOS 拦截启动，关闭提示，打开“系统设置 → 隐私与安全性”，选择“仍要打开”，再确认打开 Intrica。
3. 如果没有“仍要打开”选项，请向设备管理员核实安全策略。不要全局关闭 Gatekeeper。

替换已有应用前，先退出 Intrica；升级前备份工作区，见[更新与备份](#更新与备份)。

### Linux

在 Debian 或 Ubuntu 上，进入安装包所在目录后运行：

```sh
sudo apt install ./Intrica-0.3.1-linux-amd64.deb
intrica
```

AppImage 需要图形桌面会话：

```sh
chmod +x Intrica-0.3.1-linux-x86_64.AppImage
./Intrica-0.3.1-linux-x86_64.AppImage
```

如果没有可用的 FUSE 2，使用 AppImage 的解压运行模式：

```sh
APPIMAGE_EXTRACT_AND_RUN=1 ./Intrica-0.3.1-linux-x86_64.AppImage
```

以普通用户运行桌面应用。没有图形桌面的主机使用原生服务器包或容器。

### 校验手动下载的文件

从同一版本下载 [SHA256SUMS](https://github.com/M0gician/intrica/releases/download/v0.3.1/SHA256SUMS)。计算安装包的 SHA-256，与清单中相同文件名对应的值比较。例如：

```sh
# macOS
shasum -a 256 Intrica-0.3.1-mac-arm64.dmg
# Linux
sha256sum Intrica-0.3.1-linux-amd64.deb
```

校验值不一致时不要安装，应从发布页重新下载。校验值用于核对文件内容，不能代替对发布者的信任判断。

### 可选：使用桌面安装脚本

已安装 Bash 和 curl 时，可以下载固定版本的脚本：

```sh
curl -q --fail --location --proto '=https' --proto-redir '=https' \
  https://github.com/M0gician/intrica/releases/download/v0.3.1/install.sh \
  -o install.sh
```

阅读下载的脚本并退出 Intrica，然后运行：

```sh
bash install.sh v0.3.1
```

脚本会校验安装包。macOS 安装到 `/Applications/Intrica.app`；Debian/Ubuntu 使用 `apt-get` 安装；其他 Linux x64 系统将 AppImage 安装为 `~/.local/bin/intrica`。脚本只在安装需要时申请管理员权限。macOS 首次启动仍需按上述步骤批准。

## 开始使用

1. 打开应用。本地桌面版自动启动内置服务器，无需填写服务器地址或访问令牌。如需切换界面语言，打开“设置 → 通用”。
2. 打开“设置 → 模型”，按模型服务商提供的基础地址添加 API 端点和 API 密钥。仅在端点不要求密钥时勾选“无需 API 密钥”。添加模型，选择端点支持的协议，测试后选择使用。进入模型编辑器时会自动获取模型列表，也可以刷新列表或手动填写模型 ID。缺少有效配置时不能发送，但可以编辑和保留草稿。调用服务商的模型可能产生费用。
3. 从画布菜单新建画布。
4. 添加和连接资料。单击选择节点，双击打开内容。
5. 给 Agent 分配任务。它申请额外资源或宿主权限时，先审查再批准。

Agent 会话、模型会话和协作消息均支持右侧历史导航、预览和书签。设置包含服务器连接、快捷键修改、并发限制、运行统计和更新。界面支持中文和英文。

## 服务器安装

在可信主机上使用专用的非 root 账号。文件工具和命令在当前连接的服务器上执行。Intrica 访问令牌授予服务器所有者权限，与模型 API 密钥及 GitHub 凭据分别管理。

### Linux 原生服务

Linux x64 原生包自带 Node.js、PostgreSQL 和 Web 界面。主机需要 Bash、curl、`tar`、`sha256sum`、`flock`、systemd 用户服务和 linger。默认工具沙箱还需要支持非特权用户命名空间的 `/usr/bin/bwrap`。安装程序会尝试为当前服务账号启用 linger，不执行 sudo。若主机策略拒绝此操作，再由管理员执行 `loginctl enable-linger SERVER_USER`。Ubuntu 22.04 管理员可安装所需的 `bubblewrap` 和 `curl`。安装脚本不会修改防火墙或命名空间策略，也不允许以 root 运行。

直接以服务账号登录主机，检查用户会话和隔离功能：

```sh
systemctl --user show-environment
loginctl show-user "$(id -un)" -p Linger --value
/usr/bin/bwrap --unshare-all --die-with-parent --new-session \
  --ro-bind / / --proc /proc --dev /dev /bin/true
```

linger 检查应输出 `yes`，用户会话检查应成功。使用沙箱模式时，Bubblewrap 检查也必须成功。然后下载并阅读安装脚本：

```sh
curl -q --fail --location --proto '=https' --proto-redir '=https' \
  https://github.com/M0gician/intrica/releases/download/v0.3.1/install-server.sh \
  -o install-server.sh
```

仍以该非 root 用户运行，不要加 `sudo`：

```sh
bash install-server.sh v0.3.1
systemctl --user status intrica-server
curl --fail http://127.0.0.1:3001/api/v2/ready
```

如果主机不允许创建用户命名空间，可以明确选择**无沙箱模式**，用以下命令替代默认安装命令：

```sh
bash install-server.sh v0.3.1 --no-sandbox
```

请使用无 sudo 权限且不存放个人凭据的专用服务账号。应用权限检查仍然生效，但 shell 和 MCP 命令能够访问该账号可用的全部文件和网络资源，工作目录不会限制其访问范围。此操作不修改内核设置。升级保留所选模式；主机通过隔离检查后，可用 `--sandbox` 恢复默认沙箱。详见[执行模式说明](docs/self-hosting.md#explicit-no-sandbox-mode)。

首次安装默认监听 `127.0.0.1:3001`，退出 SSH 会话后继续运行，并随主机启动。配置和访问令牌保存在 `~/.config/intrica/server.json`，默认数据目录为 `~/.local/share/intrica-server/state`。手动连接时，私下读取配置中的 `accessToken`；不要公开配置文件，也不要将数据库密码填入连接表单。服务日志可用 `journalctl --user -u intrica-server -n 80` 查看。

### 通过 SSH 部署或连接

桌面版可以执行上述原生服务安装：

1. 配置 SSH 密钥认证，并与管理员提供的指纹核对主机密钥。Intrica 使用严格的主机密钥检查和非交互 SSH；加密密钥应先加载到 SSH agent，不支持弹出 SSH 密码输入框。
2. 打开“设置 → 服务器连接 → 添加服务器”，选择 SSH 配置别名，或选择“手动添加服务器…”并填写主机、非 root 用户名和 SSH 端口。
3. 首次部署选择“安装并连接”。客户端自动选择匹配版本，检查主机并显示下载、传输、安装和验证进度。如需无沙箱模式，先选择该选项并阅读权限提示。
4. 安装通过健康检查后，客户端自动保存并启用连接。离开设置面板不影响安装；重新打开可继续查看进度。
5. 同一账号下已经安装服务时，直接选择“添加”，无需重新部署。

桌面版管理 SSH 隧道，并通过 SSH 获取服务访问令牌，无需 GitHub 令牌。浏览器用户可以在本地电脑建立隧道，将 `intrica-host` 替换为自己的 SSH 配置别名：

```sh
ssh -N -L 127.0.0.1:3301:127.0.0.1:3001 intrica-host
```

保持隧道运行，打开 `http://127.0.0.1:3301`，输入服务器的 Intrica 访问令牌。连接已有 HTTPS 服务时，在桌面版手动连接中选择“HTTP / HTTPS”，填写地址和访问令牌。不可信网络中使用 HTTPS 或 SSH。运维细节见[自托管指南](docs/self-hosting.md)和 [SSH 部署指南](docs/architecture/ssh-server-deployment.md)。

### Docker Compose

使用已安装 Docker Engine 和 Docker Compose v2 的 Linux x64 主机。在新建的持久部署目录中下载 Compose 文件：

```sh
mkdir intrica-deployment
cd intrica-deployment
curl -q --fail --location --proto '=https' --proto-redir '=https' \
  https://github.com/M0gician/intrica/releases/download/v0.3.1/compose.release.yaml \
  -o compose.release.yaml
openssl rand -hex 32
```

用编辑器在该目录创建 `.env`。从 [intrica-update.json](https://github.com/M0gician/intrica/releases/download/v0.3.1/intrica-update.json) 复制完整的 `serverImage` 值到 `INTRICA_IMAGE`，替换下方镜像摘要占位值。将令牌占位值替换为刚生成的随机值并妥善保管：

```ini
INTRICA_IMAGE=ghcr.io/m0gician/intrica@sha256:RELEASE_DIGEST
INTRICA_ACCESS_TOKEN=REPLACE_WITH_YOUR_RANDOM_VALUE
```

**启动前请检查监听地址：**发布文件中的 `3001:3001` 会监听主机的全部网络接口。如果只从主机或 SSH 隧道访问，将其改为 `127.0.0.1:3001:3001`。需要通过网络访问时，先配置 HTTPS 和网络访问限制。

```sh
chmod 600 .env
docker compose -f compose.release.yaml up -d --wait
docker compose -f compose.release.yaml ps
```

在主机打开 `http://127.0.0.1:3001`，或使用上述 SSH 隧道，再输入 `INTRICA_ACCESS_TOKEN` 登录。拉取镜像无需 `docker login`。保留 `.env`、部署目录及 `pgdata`、`intrica-data` 两个卷；`docker compose down -v` 会删除工作区数据卷。

## 从源码运行

安装 Git、Node.js **24.18.0** 和 pnpm **11.20.0**，然后运行：

```sh
git clone --branch v0.3.1 --depth 1 https://github.com/M0gician/intrica.git
cd intrica
pnpm install --frozen-lockfile
pnpm --filter @intrica/desktop run prepare:app
pnpm --filter @intrica/desktop exec electron . --user-data-dir="$(pwd)/.data/desktop-dev"
```

以上命令在当前源码目录使用独立的桌面开发配置目录。仅使用浏览器时，在依赖安装完成后运行：

```sh
HOST=127.0.0.1 pnpm web
```

打开 `http://127.0.0.1:3001`，按 Ctrl+C 停止服务。不设置 `HOST` 的 `pnpm web` 会监听全部网络接口，并输出含访问令牌的 URL，请勿公开该地址。浏览器开发默认将数据保存在 `.data/web`。构建和测试说明见[开发指南](docs/development.md)。

## 更新与备份

在支持自动安装的桌面版中，选择“设置 → 版本与更新 → 更新并重启”。应用保存草稿、停止本地服务、替换应用并重新启动，检查实际版本及原工作区后才显示完成。旧版 macOS 客户端可以打开新签名 DMG 内的 Intrica，再选择“安装并重启”完成过渡，无需手动退出或拖动覆盖。桌面更新包含内置服务器，远程服务器需单独更新。

升级前停止所有应用写入进程，备份 PostgreSQL 和完整数据目录。桌面版退出后，复制以下完整目录：

- macOS：`~/Library/Application Support/Intrica`
- Linux：`${XDG_CONFIG_HOME:-$HOME/.config}/Intrica`

原生服务需要备份配置指定的数据目录及 `~/.config/intrica/server.json`，并使用原服务账号安装新版本。Compose 部署保留 `.env`、项目目录和两个数据卷，将镜像摘要更新为目标版本的值后运行：

```sh
docker compose -f compose.release.yaml pull intrica
docker compose -f compose.release.yaml up -d --no-deps --wait intrica
```

现有数据库会迁移到 schema 12。受影响会话暂停，等待核实结果并明确继续；未知副作用不会自动重试。替换回旧程序不能撤销数据库迁移。升级前阅读[更新与恢复指南](docs/updating.md)。

### 常见安装问题

- **macOS 拦截启动：**按上述步骤批准；若提示文件损坏，先校验文件，再重新下载。
- **AppImage 提示 FUSE 错误：**使用上述解压运行命令。
- **SSH 连接失败：**检查主机密钥、密钥认证、用户名和端口，以及服务账号的 systemd 用户会话和 linger。如果 Bubblewrap 不可用，请配置它或明确选择无沙箱模式。
- **服务器要求令牌：**填写 Intrica 访问令牌。模型 API 密钥和 GitHub 令牌不能用于登录 Intrica。
- **下载超时：**检查能否访问 GitHub 及其下载 CDN，代理配置见[更新指南](docs/updating.md#download-boundaries)。

## 数据与权限

模型服务会收到发送给它的上下文。Agent 使用明确的资源和宿主权限。连接目录可以授权重复执行宿主命令；工作目录本身不构成文件访问隔离。没有操作系统隔离时，命令使用服务器账号的权限。

Intrica 面向个人及互相信任的小团队，使用共享所有者权限，不提供独立租户账号或成员之间的工作区隔离。保护服务器凭据和备份，在不可信网络中使用 HTTPS 或 SSH。详见[安全说明](SECURITY.md)。

## 开发

- [开发指南](docs/development.md)
- [贡献指南](CONTRIBUTING.md)
- [更新说明](CHANGELOG.md)
- [报告问题](https://github.com/M0gician/intrica/issues)

公开问题报告中不要包含密钥、私人会话或工作区导出。

## 许可证

[MIT](LICENSE)。第三方组件保留各自的[许可证及分发要求](docs/development/distribution-licenses.md)。
