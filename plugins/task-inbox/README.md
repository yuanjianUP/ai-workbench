# Orca 任务收件箱原型

这是一个独立的 Orca 侧边栏插件，支持记录和查看手动任务。任务保存在 Orca 为此插件提供的私有存储中；当前仅适合单面板使用，多个面板同时写入可能覆盖彼此的修改。它不会启动 Agent、修改仓库或向外部发送数据，也不提供任务执行状态。

插件要求 Orca `>=1.4.246`。在 Orca 的 Settings → Plugins 中启用插件，通过 Development folders 添加本目录，然后审阅并启用插件。启用插件需要在 Orca 中确认权限；插件只申请 `storage:own`。也可在配置好 Orca CLI 后使用 `orca plugin validate` 和 `orca plugin dev load`，具体参数请以本机 CLI 的帮助为准。Linux 上命令可能叫 `orca-ide`。

此原型已在 Orca 1.4.257 临时开发加载，面板截图无错误；一次性私有键的写入、读取和删除已通过真实面板验证。导出和独立配置尚未验收。安装前应核对当前 Orca 版本和权限提示。禁用插件即可停止使用；插件数据的保留和删除以 Orca 的实际行为为准。

Orca 的 `taskSources` 扩展点目前保留、不能使用。后续若要接入 GitHub 和飞书，需要单独设计事件接收、授权与任务服务，再通过插件 worker 与服务通信；沙箱面板本身不能直接联网。Agent 启动可评估 Orca 的 `agent.launch`，但 worktree 创建、停止、恢复及权限限制仍需逐项验证。插件不能替代执行环境的安全隔离。

面板提供“导出原型任务”按钮，通过 Orca 的保存对话框将现有私有存储导出为带时间戳的 JSON 文件，不会修改原数据。该功能尚未在 Orca 沙箱中验证；导出文件可按[任务存储说明](../../services/task-service/README.md)预览并确认导入。

参考：[插件编写指南](https://github.com/stablyai/orca/blob/main/docs/reference/plugin-authoring.md)、[插件清单](https://github.com/stablyai/orca/blob/main/docs/reference/plugin-manifest.md)、[宿主 API](https://github.com/stablyai/orca/blob/main/docs/reference/plugin-host-api.md)。
