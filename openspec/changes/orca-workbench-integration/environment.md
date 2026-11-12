# 环境验证记录

验证日期：2026-11-12；环境：Linux WSL2，内核 6.6.87.1-microsoft-standard-WSL2，Node.js v24.18.0。

## Orca CLI

2026-11-12 再次检查：`orca-ide --version` 返回 `1.4.257`，`orca-ide status --json` 显示应用运行、runtime reachable 且 graph ready。此前 socket 错误未复现。CLI 桥接至 Windows 宿主，直接对 WSL 路径运行 `plugin validate` 被拒绝，提示必须在插件文件所在机器运行；这不代表插件验证通过。尚未在隔离配置中加载插件。

后续使用 Windows 上的 Orca CLI 直接读取 WSL UNC 路径进行离线校验，`plugin validate` 返回 `valid: true`，插件标识为 `local.task-inbox`；需要批准 sandboxed-ui 和 `storage:own`。该结果仅检查清单和文件，没有运行插件或验证私有存储。`orca-ide worktree list --json` 和 `terminal list --json` 均返回 `ok: true`，但尚未验证创建、启动、读取、停止和恢复。

再次从 WSL 执行 `orca-ide plugin validate plugins/task-inbox --json` 返回 `invalid_environment`：插件文件操作必须在运行 Orca 的机器上执行。版本匹配的插件指南还要求运行代码的插件经过权限批准；当前尚未在隔离配置完成加载及停用演练。

随后经用户授权，在当前 Windows Orca 1.4.257 的开发配置临时加载 `local.task-inbox`（`sandboxed-ui`、`storage:own`）和 `local.task-workbench`（`trusted-worker`、`settings:own`、`secrets:own`、`workspace:read`、`workspace:write`、`agent:launch`、`terminal:read`）。两个面板的 `plugin shot` 均成功且没有报告错误；原型面板显示保存和导出控件。工作台 worker 的 `workspaces.list` 返回实际工作区；未设置 socket 时 `tasks.list` 明确报配置错误，且已通过代码中的 `secrets.protection` 检查。测试后两个开发目录均已通过 `plugin dev unload` 移除。没有修改原型私有任务、设置服务令牌或启动 Agent；这是当前用户配置，不是独立的隔离 Orca 配置，也没有验证存储读写或导出对话框。

同日补充：在已批准的 `local.task-inbox` 开发面板临时加入测试代码，用单独的一次性键验证 `storage.set`、`storage.get`、`storage.delete` 及删除后读取为空，面板截图显示通过且无错误。测试未改动原型任务键；结束后恢复面板源码并卸载开发插件。这仍是当前用户配置，不是隔离配置，未验证导出对话框。

再次尝试真实导出：Orca 窗口在桌面交互期间处于最小化状态，辅助功能触发导出按钮的结果未获确认，窗口列表未显示保存对话框；恢复窗口后再次尝试返回 `accessibility_error: windowNotFound("133614")`。因此没有声称导出成功或生成文件，测试后卸载了开发插件。后续需要可交互的前台窗口完成保存并核对导出文件。

- 插件清单要求 Orca >= 1.4.246；本次读取到的版本 1.4.257 满足该最低版本要求。
- `orca-ide` 位于 `/home/administrator/.local/bin/orca-ide`，是调用 Windows Orca 的 WSL 桥接脚本；其桥接脚本及 Windows `orca.exe` 均存在。
- `orca-ide --version` 和 `orca-ide --help` 均输出 `UtilBindVsockAnyPort:307: socket failed 1`，退出码为 1。
- `wslpath -w /tmp` 成功，说明路径转换可用；错误发生在 Windows 互操作链路，具体根因尚未确定，不能把路径转换成功当作 CLI 可用。
- 上述互操作错误是此前的结果，现已不再复现。仍需按任务清单验证插件、权限和各宿主接口；不能根据旧错误推断 Orca 不支持某项接口。

## 本地存储

2026-11-12 真实 worker 通信补充：在 Windows Node 24.11.1 启动仅使用临时数据库的任务服务，监听随机名称的本机 `\\\\.\\pipe\\ai-workbench-*` 管道。在已批准的 `local.task-workbench` 开发插件中临时加入测试处理程序，通过 Orca 1.4.257 调用原有服务连接函数；OS 密钥保护检查通过，临时令牌经 `secrets.set` 和 `secrets.get` 使用，创建及读取测试任务成功，错误令牌返回未授权。处理程序恢复原插件设置和密钥，测试后恢复代码、卸载开发插件并停止服务。该测试未操作实际面板或启动 Agent，也未验证 Windows 管道 ACL；同用户进程能够访问的令牌不提供同用户隔离。部署时 Orca 和服务均须在 Windows 上，使用私有数据库及随机管道名和令牌。

同日容器隔离探测：Docker Desktop Linux 引擎恢复可用，使用已有镜像和临时目录运行一次性容器，关闭网络、只读根文件系统、丢弃所有 capabilities、启用 `no-new-privileges`、指定非特权 UID，仅挂载临时工作目录。探测确认容器内只有 loopback 接口、进程为自身 PID 命名空间的 PID 1、有效 capabilities 为零、根目录不可写，宿主合成凭据文件和环境变量不可见，工作目录可写；容器和临时文件随后删除。这只是隔离机制探测，不证明 Windows Orca 启动的 Agent 受这些限制，也未验证真实 Agent 凭据、worktree 和进程树；自动执行保持关闭。

Node.js 内置 SQLite 可用。本仓库的命令行和 Unix socket 服务已验证空内容拒绝、重启后读取和重复初始化。socket 权限为 0600，任务管理接口还要求随机令牌；两者不能隔离能读取令牌的同用户进程。Windows 本机 worker 通信和系统密钥保护已按上文测试；跨 Windows/WSL 通信未接入，自动执行保持未实现。
