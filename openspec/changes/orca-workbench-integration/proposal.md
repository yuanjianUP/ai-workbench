## Why

现有仓库只有未在 Orca 中验证的手动收件箱原型，尚不能可靠地管理或执行来自不同来源的任务。需要在不改动现有 Orca 的前提下，建立可逐步验证的任务服务和插件集成方案。

## What Changes

- 增加独立任务服务和 Orca 插件界面，持久化并展示手动任务及执行信息。
- 验证并接入 Orca 工作区、Agent 启动和审查能力；不可用的能力明确提示，不伪造状态。
- 按阶段接入 GitHub、飞书事件，验证来源与授权，去重并按明确规则反馈。
- 明确执行环境、权限、凭据和外部操作的边界，并验证失败恢复。

## Capabilities

### New Capabilities

- `task-management`: 手动任务的持久化、查看和状态管理。
- `orca-execution`: Orca 插件集成、执行控制、结果审查与隔离边界。
- `external-intake`: GitHub 和飞书事件校验、授权、去重与来源反馈。

### Modified Capabilities

无。

## Impact

影响本仓库插件、新增 TypeScript 任务服务及其数据库和测试；依赖运行中的兼容 Orca，以及后续配置的 GitHub、飞书服务。现有 Orca 不需要修改；插件安装、权限授予和外部服务配置由使用者控制。功能可用性取决于实际 Orca 版本和接口验证。
