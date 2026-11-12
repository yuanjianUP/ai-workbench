# Orca 能力核对（进行中）

目标运行时：Orca 1.4.257；检查日期：2026-11-12。CLI 帮助、上游文档和运行时实测是不同证据，只有实际运行成功才标为已验证。

| 能力 | 当前证据 | 集成处理 |
| --- | --- | --- |
| 查询工作区 | `worktree list --json` 返回成功；插件文档列出 `workspace.list` | 可继续验证 worker 返回的数据和权限。 |
| 创建工作区 | Orca CLI 在一次性 Git 仓库中成功创建并清理 worktree；插件宿主参考未列出创建接口 | 插件不展示已创建；通过 Orca 手动创建作为临时方式。 |
| 启动 Agent | Orca 1.4.257 真实 worker 在临时 worktree 启动 Codex，返回终端句柄并记录到临时服务 | 不假设启动成功代表任务完成；失败或无法确认时保持未知。 |
| 读取终端 | 真实 worker 使用 `terminal.read` 读取当前工作会话及真实启动的 Codex 终端成功；直接使用 CLI 列表的 ptyId 返回 `terminal_handle_stale` | 使用 `agent.launch` 返回的终端句柄；断连或读取失败提示未知，不推断成功。 |
| 停止 | Orca 1.4.257 的 CLI 已创建专用 shell 终端、读取输出并关闭该终端，返回 `ptyKilled: true`；插件宿主没有列出关闭方法，这也不证明 Agent 及其子进程已结束 | 插件不承诺停止成功，使用 Orca 手动停止并检查进程。 |
| 恢复 | 运行时报告部分 session restore 能力；插件可用性及恢复语义未测 | 不自动重启，保留未知状态，人工核对。 |
| 审查变更 | CLI 帮助列出 `file diff` 和 `file open-changed`；实际打开未测 | 用户可通过 Orca 自行审查；不把接口存在当作审查通过。 |

2026-11-12 补充：通过当前 CLI 的 `skills get orca-plugin-authoring --reference references/host-api.md` 读取版本匹配的宿主参考。它列出 worker 的 `workspace.list`、`agent.launch`、`terminal.read`、`editor.open` 和 `secrets.protection`，分别需要相应权限；面板可通过 `plugin.request` 调用自身 worker。参考未列出工作区创建、终端停止或会话恢复的插件宿主方法，也未提供代码变更列表方法。CLI 的相应功能不能证明插件可调用。这些仍是文档证据，不是运行时验证。

同日补充：临时加载本项目工作台插件后，通过 `plugin dev request` 实际调用 worker 的 `workspace.list` 成功，返回三个工作区且未截断。未配置 socket 时任务列表返回明确配置错误；请求经过 `secrets.protection` 检查，表明当次运行报告了可用的 OS 密钥保护。其他 worker 操作仍未在实际运行时验证；测试后已卸载开发目录。

插件 worker 在 Orca 宿主运行；当前 CLI 从 WSL 转发至 Windows 宿主，不能假设 Windows worker 可直接访问 WSL Unix socket。已在 Windows 本机以命名管道、临时令牌和系统密钥库完成真实 worker 通信及错误令牌拒绝测试，详见 environment.md；自动执行的隔离仍未验证，保持关闭。

上游插件文档：[宿主 API](https://github.com/stablyai/orca/blob/c259923c33bbb3f9057e8132eb67862a6f818a7a/docs/reference/plugin-host-api.md)。该源码提交与本机二进制不一定相同；权限、参数和结果仍应以目标版本实测为准。
