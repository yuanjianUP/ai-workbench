# 本地任务存储原型

需要 Node.js 24，使用内置 SQLite 和 TypeScript 类型剥离，无需安装依赖。服务使用本机 Unix socket 或 Windows 命名管道，不监听 TCP。工作台插件的 Windows worker 通信已在 Orca 中通过临时测试处理程序验证，面板交互尚未验收。

```sh
export TASK_DB="$PWD/tasks.db"
node services/task-service/cli.ts create '任务内容'
node services/task-service/cli.ts list
node services/task-service/cli.ts get <任务ID>
node services/task-service/cli.ts import 原型导出.json
node services/task-service/cli.ts import 原型导出.json --confirm
node --test services/task-service/*.test.ts
```

启动服务（socket 所在目录应仅允许当前用户访问）：

```sh
mkdir -p -m 700 /tmp/task-service-$(id -u)
export TASK_SOCKET="/tmp/task-service-$(id -u)/service.sock"
export TASK_API_TOKEN="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")"
node services/task-service/server.ts
```

Windows PowerShell 中可将 `TASK_DB` 指向私有目录下的数据库文件，将 `TASK_SOCKET` 设置为形如 `\\.\pipe\ai-workbench-<随机标识>` 的本机命名管道，并设置相同格式的随机 `TASK_API_TOKEN` 后运行同一服务。Windows 管道没有 Unix 的 0600 模式，必须依靠令牌认证和账户隔离；同账户进程仍可能读取环境变量。Windows Node 24.11.1 和 Orca 1.4.257 的真实 worker 已通过临时管道连接和错误令牌拒绝测试；详见环境记录。

例如，在当前用户已限制访问的目录中，从项目根目录的 PowerShell 启动：

```powershell
$env:TASK_DB = Join-Path $env:LOCALAPPDATA 'ai-workbench\tasks.db'
New-Item -ItemType Directory -Force (Split-Path $env:TASK_DB) | Out-Null
$env:TASK_SOCKET = '\\.\pipe\ai-workbench-' + [guid]::NewGuid().ToString('N')
$env:TASK_API_TOKEN = node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))"
node services/task-service/server.ts
```

将本次的管道路径填入插件设置，将令牌填入插件面板。上述命令每次启动生成新令牌和管道名；长期使用时应由用户提供持久化的受保护配置。不要把令牌写入仓库或共享终端日志。

在另一终端安全地提供同一个 `TASK_API_TOKEN`，使用 `curl --unix-socket "$TASK_SOCKET" -H "Authorization: Bearer $TASK_API_TOKEN" http://localhost/tasks` 查看任务，或加上 `-H 'Content-Type: application/json' -d '{"text":"任务内容"}'` 创建任务。详情地址为 `/tasks/<id>`。令牌必须是 32 字节随机值的小写十六进制编码；服务启动时要求配置。不要把令牌提交到仓库或暴露在日志中；命令行参数和环境变量可能被同用户进程读取。正常停止时 socket 会移除；异常退出后如确认没有服务运行，可删除遗留的 socket 文件再启动。服务以 0600 权限创建 socket；令牌和文件权限不能隔离有权读取密钥的同用户进程。Windows worker 应连接 Windows 服务，不能把 WSL socket 直接当作 Windows 命名管道。

数据库首次打开时创建表，之后重复打开不会清除数据。导入先不加 `--confirm` 预览，再显式确认；相同文件内容重复导入会被识别并跳过，不修改原文件或原型存储。不同内容的导出文件不会逐条去重，导入前应检查，避免重复任务。插件导出尚未在 Orca 中验证。数据库包含任务内容，应由使用者放在权限受限的位置并备份。服务保存执行意图，实际启动由工作台插件请求 Orca；真实 Orca 执行尚未验证。

执行意图会以未知状态持久化，并阻止同一任务再次创建意图。`node services/task-service/cli.ts executions` 可查看记录和人工核对审计；只有在 Orca 中独立确认相关执行及其进程均已结束后，才能运行 `node services/task-service/cli.ts review-execution <执行ID> --confirm-not-running '核对依据'` 解除阻塞。该操作记录人工核对，并不表示任务成功，也不会停止进程或自动启动任务。当前尚未接入 Orca 执行与自动状态核对。

Docker 自动执行仍处于设计和验证阶段，当前不会启动。`api-proxy.mjs` 是未接入的凭据代理原型：仅接受授权的 `POST /v1/responses`，以代理持有的独立密钥请求固定的 OpenAI API 地址，不把真实密钥传给调用方。`TASK_CODEX_BINARY=<Linux Codex 二进制路径> python3 services/task-service/docker-isolation-smoke.py` 可在已有 `python:3.11-slim-bookworm` 镜像时复现双容器模拟演练；它使用假密钥、模拟上游，不拉取镜像。真实 API、凭据管理、任务 worktree 及容器生命周期尚未联调，不能把原型视为可部署的安全边界。背景参见 [OpenAI 的沙箱安全说明](https://developers.openai.com/api/docs/guides/agents-api/environments/security)。

`docker-sandbox.mjs` 是未接入的生命周期原型：要求本机 Docker、seccomp、不可变镜像 ID 和 isolated gateway 内部网络，校验容器的用户、资源限制、挂载和只读 Git 元数据后启动。`node services/task-service/docker-sandbox-smoke.mjs` 使用模拟 Agent 测试启动及清理；设置 `TASK_CODEX_BINARY` 后运行 `node services/task-service/docker-codex-proxy-smoke.mjs` 可用真实 Codex 和模拟上游验证链路。这些测试不会访问真实 API。Docker 普通 internal 网络仍可能访问宿主网关，不能替代 isolated gateway 模式，见 [Docker 文档](https://docs.docker.com/reference/cli/docker/network/create/)。

`prepare-checkout.mjs` 提供尚未接入执行器的工作目录原型：从可信配置的本地仓库和指定分支创建独立浅克隆，不继承宿主全局 Git 配置或钩子，并移除源仓库远程地址。该克隆不是 Git 的共享 worktree，且会把所选提交中的文件交给 Agent；不得把含不应交给 Agent 的文件作为任务输入。Linux 和 Windows 的临时仓库浅克隆已测试，变更回收尚未验证。

自动执行授权规则可通过 `node services/task-service/cli.ts automation-rules` 查看，用 `automation-rule <github|feishu> <范围> <发送者> <allow|deny> --confirm` 显式设置，并用 `automation-audit` 查看授权判断审计。GitHub 的范围是仓库数字 ID，发送者是数字用户 ID；飞书的范围是 `tenant_key/chat_id`，发送者为 open_id。未设置规则默认拒绝；仅对验签并授权后保存了来源范围的事件可匹配。设置 `allow` 只保存授权意图，当前隔离执行器未接通，仍不会启动任务；旧任务若缺少来源范围同样无法匹配。

存储层定义了 GitHub 和飞书来源事件模型，以 `(source, event_id)` 去重，按来源适配器提供的验证结果与发送者名单决定是否创建待处理任务，并记录每次处理结果。此内部接口不负责验签，不能将客户端提供的验证结果视为可信。

反馈规则可以通过 `node services/task-service/cli.ts feedback-rules` 查看，并通过 `node services/task-service/cli.ts feedback-rule <任务ID> <comment|reply|pull_request> <allow|deny> --confirm` 按任务和操作类型设置。没有规则时默认拒绝；规则和反馈审计随数据库保存。设置允许规则本身不会发送反馈，也不会启用自动执行。

显式发送反馈时，先准备仅当前用户可读的 JSON 文件，例如 `{"operationKey":"唯一操作标识","taskId":"任务ID","kind":"comment","text":"反馈内容"}`；设置 `TASK_DB` 和 `GITHUB_FEEDBACK_TOKEN`，然后运行 `node services/task-service/feedback-cli.ts 反馈.json --confirm`。GitHub `pull_request` 使用 `text` 作为标题，另需 `head` 和 `base`；飞书 `reply` 使用 `FEISHU_FEEDBACK_TOKEN`。目标从验签并授权的原始事件保存，无法为没有目标信息的旧任务发送反馈。对应任务及操作的规则必须允许，命令不会自动执行。授权、操作和不确定结果会被记录；请求超时或结果未知时，同一操作标识不会再次发送，须先在来源平台核对，不能换标识盲目重试。令牌不要写入 JSON、仓库或日志。接口仅用模拟请求测试，尚未使用真实平台投递或反馈验收。

GitHub 接入目前仅支持 `issues` 的 `opened` 事件。启动服务前设置 `GITHUB_WEBHOOK_SECRET`、`GITHUB_ALLOWED_SENDERS` 和 `GITHUB_ALLOWED_REPOSITORIES`，后两者是逗号分隔的 GitHub 数字用户 ID 和仓库 ID。`POST /webhooks/github` 校验 `X-Hub-Signature-256`、仓库和发送者，再创建待处理任务；配置缺失时返回 503。去重使用签名正文中的仓库和 issue ID，防止更换未签名的投递 ID 后重复创建。

飞书 `POST /webhooks/feishu` 仅支持启用 Encrypt Key 的事件订阅及 `im.message.receive_v1` 用户文本消息。启动前设置 `FEISHU_ENCRYPT_KEY`、`FEISHU_VERIFICATION_TOKEN`、`FEISHU_APP_ID`，以及逗号分隔的 `FEISHU_ALLOWED_TENANTS`、`FEISHU_ALLOWED_SENDERS`（open_id）和 `FEISHU_ALLOWED_CHATS`；配置不全时返回 503。加密 URL 验证返回 challenge，事件校验签名和允许名单，使用事件 ID 去重。实现依据[飞书事件接收文档](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/encrypt-key-encryption-configuration-case)。

服务只监听 Unix socket，外部平台不能直接访问；真实投递需要由使用者配置 HTTPS 反向代理，保留原始请求体与请求头，限制请求体最大 16 KiB。现有测试使用本地构造样例，尚未验证真实投递或代理部署。
