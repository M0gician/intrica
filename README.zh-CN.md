<p align="center">
  <img src="apps/desktop/assets/icon.svg" width="88" alt="Intrica 标志">
</p>

<h1 align="center">Intrica</h1>
<p align="center">用于组织想法、资料和 AI Agent 的可视化工作区。</p>
<p align="center"><a href="README.md">English</a> · <strong>简体中文</strong></p>

将笔记、文件、图片、PDF、网页和待办放在同一画布，连接资料，分配 Agent 任务，并审查权限申请和执行结果。Intrica 在你的电脑或自托管服务器上运行。

## 安装或从源码运行

从 [Releases](https://github.com/M0gician/intrica/releases) 下载已发布的 macOS arm64 或 Linux x64 安装包。公开下载和更新检查无需 GitHub 账号、令牌或 GitHub CLI。

桌面版自带 Node.js、PostgreSQL 和 Web 界面。暂不分发 Windows、Intel Mac 或 Linux arm64 安装包。未经过 Apple 公证的 macOS 安装包，在首次启动被拦截后，需要在“系统设置 → 隐私与安全性”中明确批准。

源码运行需要 Node.js 24.18.0 和 pnpm 11.20.0：

```sh
pnpm install --frozen-lockfile
pnpm desktop
# 或在浏览器中运行：
pnpm web
```

## 开始使用

1. 从画布菜单新建画布。
2. 打开“设置 → 模型”，添加模型服务地址和密钥，获取或添加模型，测试后选择使用。内置模拟模型不会发送真实模型请求。
3. 添加和连接资料。单击选择节点，双击打开内容。
4. 给 Agent 分配任务。它申请额外资源或宿主权限时，先审查再批准。

Agent 会话、模型会话和协作消息均支持右侧历史导航、预览和书签。设置包含服务器连接、快捷键修改、并发限制、运行统计和更新。界面支持中文和英文。

## 自托管与更新

桌面版支持 HTTP(S) 和 SSH 连接。“设置 → 服务器连接”显示 SSH 配置别名，也可以手动填写主机、用户名和端口。远程部署需要受支持的 Linux x64 主机、已信任的 SSH 主机密钥、systemd 用户会话和可用的 Bubblewrap。

原生服务和容器部署见[自托管指南](docs/self-hosting.md)。桌面更新与远程服务器更新分别执行。安装包按固定版本下载并校验；安装和远程服务变更需要用户明确操作。

升级前备份数据库及完整数据目录。操作和恢复步骤见[更新指南](docs/updating.md)。

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
