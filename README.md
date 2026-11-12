# 个人 AI 开发工作台

本项目用于规划和开发个人 AI 开发工作台。目标是提供类似 dsh-superagent-prototype 的 GitHub、飞书任务接入和自动处理能力，并允许为任务选择不同的编码 Agent。

详细规划见 [项目规划](docs/plan.md)。本仓库包含 [Orca 任务收件箱插件原型](plugins/task-inbox/README.md)和开发中的[工作台插件](plugins/task-workbench/README.md)。后者已实现服务连接与手动执行代码，但尚未在真实 Orca 中验收。任务服务提供有限的 GitHub 和飞书事件接收，尚未验证真实平台投递。

OpenSpec 变更规划见 [Orca 工作台集成](openspec/changes/orca-workbench-integration/proposal.md)，实施步骤和验收方式见[任务清单](openspec/changes/orca-workbench-integration/tasks.md)。

本地任务服务和存储命令行的用法见 [任务存储原型](services/task-service/README.md)；Orca 环境验证及当前阻塞见[环境记录](openspec/changes/orca-workbench-integration/environment.md)。
