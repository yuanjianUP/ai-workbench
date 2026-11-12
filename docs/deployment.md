# 部署、备份和回退

本指南针对 Linux/WSL 上的 Node.js 24 本地服务；它还不是完整 Orca 集成部署指南。服务不直接监听公网，也不会自动发送反馈；可按[服务说明](../services/task-service/README.md)显式授权和发起反馈。原型收件箱与服务各自存储任务；新工作台插件的端到端手动启动尚未在 Orca 中验收，详见[插件说明](../plugins/task-workbench/README.md)。

## 启动和权限

准备仅当前用户可访问的持久化目录与运行目录，例如：

```sh
install -d -m 700 "$HOME/.local/share/ai-workbench" "$HOME/.local/share/ai-workbench/run"
export TASK_DB="$HOME/.local/share/ai-workbench/tasks.db"
export TASK_SOCKET="$HOME/.local/share/ai-workbench/run/service.sock"
export TASK_API_TOKEN="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")"
node services/task-service/server.ts
```

运行目录不得被其他用户写入；socket 创建为 0600，同一系统用户的其他进程仍可访问。服务异常退出可能留下 socket；确认服务未运行后再移除它。数据库及相关备份含任务内容，目录及备份应保持私有。GitHub 和飞书允许名单、密钥及事件类型见[服务说明](../services/task-service/README.md)。密钥通过运行环境提供，不应写入仓库；环境变量可能被同用户进程读取，实际部署应限制本机账户及服务进程权限。

外部事件需要 HTTPS 反向代理与公网域名；代理必须只开放对应的 `/webhooks/github` 和 `/webhooks/feishu` 路径，将请求原样转发至 socket，并限制请求大小。可参考 [nginx 配置](nginx-webhooks.conf)：在 nginx 的 `http` 块中包含该文件，替换证书路径，调整监听端口，并将服务 socket 配为 `/run/ai-workbench/service.sock`。服务创建的 socket 是 0600，nginx worker 必须以有权访问该 socket 的用户运行；不要通过放宽 socket 权限使管理接口可被其他本机用户访问。绝不能把 `/tasks` 或 `/executions` 等本地管理接口暴露到公网：它们需要令牌，但目前只针对本地通信设计。当前尚未演练公开代理部署或接收真实平台投递。自动执行和跨 Windows/WSL 通信仍未接入；显式反馈连接也尚未在真实平台验收。

## 备份和恢复

停止服务和所有操作同一数据库的 CLI 进程，等待退出，再复制完整数据库文件至权限为 700 的备份目录；不要在写入期间直接复制正在使用的 SQLite 文件。恢复前先保留当前数据库，将备份复制至新路径并以 `TASK_DB` 指向新路径启动，检查任务列表。若启用 WAL 或其他 SQLite 设置，须使用 SQLite 备份机制或同时正确处理相关文件；当前服务默认未设置 WAL。

## 迁移和回退

插件原型数据先在 Orca 中导出，再通过 `node services/task-service/cli.ts import <文件>` 预览；检查内容后加 `--confirm` 导入。重复导入完全相同的文件会跳过，内容不同的文件不会逐条去重。导出功能仍需在目标 Orca 中验证，原型数据不会自动删除。

回退时停止服务、停用外部平台投递并保留数据库和原型数据；恢复旧服务前先备份数据库。当前建表操作可重复执行，但尚无面向未来版本的向下迁移机制；不要假定旧代码理解新数据库结构。停用或卸载插件时先确认 Orca 对插件私有数据的实际保留行为。

## 演练记录

2026-11-12：在当前 WSL 环境中新建权限受限的临时数据和备份目录，用 CLI 创建任务，进程退出后复制数据库，并从备份路径成功读取该任务。此演练没有覆盖全新操作系统、代理、Orca 插件或真实平台投递，因此不能视为完整交付演练。

同日补充：在 WSL 中通过 `env -i` 清空继承的配置，使用全新临时数据目录演练原型 JSON 的预览、确认导入、重复导入和停止进程后的数据库复制及恢复读取。预览时数据库无任务，确认后导入一条，重复导入被识别，备份中可读取原任务。Docker 守护进程检查在 5 秒内未响应；上述隔离仅覆盖环境变量和数据目录，不是全新操作系统，也未覆盖 Orca 和反向代理。

同日再次检查 Docker Desktop Linux 引擎已可用。使用本地 `python:3.11-slim-bookworm` 镜像及只读挂载的 Node 24.18.0 和项目源码，在无网络、只读根文件系统、丢弃全部 capabilities、`no-new-privileges`、非特权 UID 和临时数据目录的容器中，分别验证导入预览、确认、重复导入、数据库备份恢复，以及服务启动、0600 socket、停止和从备份重启读取。容器使用后自动删除。此演练不包括 Orca、反向代理、真实平台投递或 Agent 凭据与进程隔离。

同日代理演练：两个仅共享隔离容器网络和临时 socket 的非特权容器运行任务服务与 nginx 1.26.3，使用临时自签名证书验证 TLS 代理。有效签名的模拟 GitHub 事件被接收，重复投递被去重，错误签名返回 403；未配置的飞书入口返回 503，管理接口返回 404，超过 16 KiB 的请求返回 413。演练未连接真实平台，也未验证公网域名和正式证书。可在已有 `python:3.11-slim-bookworm` 与兼容 nginx 镜像时执行 `TASK_PROXY_IMAGE=<本地nginx镜像> python3 services/task-service/proxy-smoke.py` 复现；脚本不拉取镜像，并清理自己创建的容器和临时文件。
