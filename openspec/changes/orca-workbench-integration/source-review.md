# 上游源码与许可证审查

审查日期：2026-11-12。以下是审查时的上游提交，不代表运行中的 Orca 与该提交完全一致。

| 项目 | 审查提交 | 许可证 | 复用建议 |
| --- | --- | --- | --- |
| [Orca](https://github.com/stablyai/orca/tree/c259923c33bbb3f9057e8132eb67862a6f818a7a) | `c259923c33bbb3f9057e8132eb67862a6f818a7a` | MIT，Copyright 2026 Lovecast Inc. | 通过插件宿主接口集成，优先不复制代码；具体能力须在目标版本验证。 |
| [dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype/tree/8c32a9dc5d72c033816c6a8110b37f40cf94fba4) | `8c32a9dc5d72c033816c6a8110b37f40cf94fba4` | MIT，Copyright 2026 DeepSeek Harness Team | 参考来源、授权、游标和审计设计；不要直接把其执行器当成 Orca 适配器。 |

两者的 MIT 许可证要求在副本或软件实质部分中保留版权及许可声明；本次仅阅读并记录，没有复制其代码。引入具体文件或依赖时仍需检查该文件及其依赖的许可证。

Orca 的 [插件宿主 API](https://github.com/stablyai/orca/blob/c259923c33bbb3f9057e8132eb67862a6f818a7a/docs/reference/plugin-host-api.md) 提供受能力约束的工作区、Agent 和密钥接口；`secrets.protection` 可报告系统密钥库不可用。源码文档不是目标机器的实测结果，特别是 worker 到 WSL 服务的通信、认证和隔离仍待验证。

DSH 的 [GitHub 来源](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/sources/github.ts)使用通知和仓库轮询，通过 `SourceContext` 调用命令、线程和工单；[飞书来源](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/sources/feishu.ts)使用 lark-cli、历史补收与线程轮询。这些代码不能直接视为 webhook 签名验证实现。来源策略、工单、线程和反馈与框架上下文相连；[DSH 执行器](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/executor/dsh.ts)依赖 DSH session、Cordis 事件及每工单工作目录，因此适合参考模型，直接迁移需要适配及重新验证。
