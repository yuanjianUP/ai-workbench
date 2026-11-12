# 工作台任务插件（开发中）

本插件与原型收件箱分开，使用 worker 通过本机 Unix socket 或 Windows 命名管道访问任务服务。插件要求 `trusted-worker`、`settings:own`、`secrets:own`、`workspace:read`、`workspace:write`、`agent:launch` 和 `terminal:read`；令牌仅保存在 Orca 的密钥存储中，只有 `secrets.protection` 报告 `os-keyring` 时才允许保存和连接。服务和 Orca worker 必须运行在同一系统；Windows Orca 应连接 Windows 上的任务服务，不能直接连接 WSL socket。不要将 socket 路径指向不可信服务，连接该路径会发送令牌。

启动任务服务，在 Orca 插件设置中填写 socket 路径，在面板保存相同的令牌，然后刷新或创建任务。保存请求超时后结果可能未知，应先刷新核对再重试。原型数据仍由原插件管理，不会自动迁移。

面板可请求手动启动 Agent、读取可用日志并打开工作区源码管理。启动前服务先保存未知执行意图；连接中断时先人工核对，不能盲目重试。执行的最终状态始终为未知，停止和恢复需要在 Orca 中人工处理。自动执行未启用。

面板显示执行 ID 和任务 ID。需要重试时，先在 Orca 中确认相关终端和进程已结束，再根据[任务服务说明](../../services/task-service/README.md)执行人工核对命令；核对只解除重复启动的阻塞，不表示任务成功，也不会停止进程。插件宿主没有经验证的停止或恢复接口。

已在 Orca 1.4.257 临时开发加载，面板无截图错误；真实 worker 已连接 Windows 命名管道服务，并在临时 Git worktree 启动 Codex、记录终端句柄和读取终端。面板任务操作和源码管理交互尚未端到端验收；终端启动不代表任务完成。测试后已卸载开发目录。运行本地连接测试：`node --test plugins/task-workbench/worker.test.mjs`。
