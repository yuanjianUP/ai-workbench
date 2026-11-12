import { readFileSync } from 'node:fs';
import { TaskStore } from './store.ts';
import { deliverFeedback } from './feedback.ts';

const [path, confirmation] = process.argv.slice(2);
if (!process.env.TASK_DB || !path || confirmation !== '--confirm' || process.argv.length !== 4) {
  console.error('用法：设置 TASK_DB 后运行 node feedback-cli.ts <反馈 JSON 文件> --confirm');
  process.exit(1);
}
const store = new TaskStore(process.env.TASK_DB);
try {
  const input = JSON.parse(readFileSync(path, 'utf8'));
  const result = await deliverFeedback(store, input, { githubToken: process.env.GITHUB_FEEDBACK_TOKEN, feishuToken: process.env.FEISHU_FEEDBACK_TOKEN });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally { store.close(); }
