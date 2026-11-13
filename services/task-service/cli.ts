import { TaskStore } from './store.ts';
import { readFileSync } from 'node:fs';

const [command, argument, confirmation, note] = process.argv.slice(2);
if (!process.env.TASK_DB) {
  console.error('请设置 TASK_DB 数据库路径');
  process.exit(1);
}
const store = new TaskStore(process.env.TASK_DB);
try {
  let result: unknown;
  if (command === 'create') result = store.create(argument ?? '');
  else if (command === 'list') result = store.list();
  else if (command === 'executions') result = { executions: store.executions(), reviews: store.executionReviews() };
  else if (command === 'feedback-rules') result = store.feedbackRules();
  else if (command === 'automation-rules') result = store.automationRules();
  else if (command === 'automation-audit') result = store.automationAuthorizationAudit();
  else if (command === 'automation-rule' && process.argv.length === 8 && process.argv[7] === '--confirm') {
    const [, , , source, scope, sender, decision] = process.argv;
    if (!['github', 'feishu'].includes(source) || !['allow', 'deny'].includes(decision)) throw new Error('自动执行规则无效');
    store.setAutomationRule(source as 'github' | 'feishu', scope, sender, decision as 'allow' | 'deny');
    result = { source, scope, sender, decision, executionAvailable: false };
  }
  else if (command === 'feedback-rule' && argument && confirmation && note && process.argv[6] === '--confirm') {
    if (!['comment', 'reply', 'pull_request'].includes(confirmation) || !['allow', 'deny'].includes(note)) throw new Error('反馈规则无效');
    store.setFeedbackRule(argument, confirmation as 'comment' | 'reply' | 'pull_request', note as 'allow' | 'deny');
    result = { taskId: argument, kind: confirmation, decision: note };
  }
  else if (command === 'review-execution' && argument && confirmation === '--confirm-not-running' && note) {
    result = store.reviewExecution(argument, note);
  }
  else if (command === 'get' && argument) {
    result = store.get(argument);
    if (!result) throw new Error('任务不存在');
  } else if (command === 'import' && argument && (confirmation === undefined || confirmation === '--confirm')) {
    result = store.importPrototype(readFileSync(argument, 'utf8'), confirmation === '--confirm');
  } else throw new Error('用法: node cli.ts create <内容> | list | get <id> | import <文件> [--confirm] | executions | review-execution <执行ID> --confirm-not-running <核对说明> | feedback-rules | feedback-rule <任务ID> <comment|reply|pull_request> <allow|deny> --confirm | automation-rules | automation-audit | automation-rule <github|feishu> <范围> <发送者> <allow|deny> --confirm');
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally { store.close(); }
