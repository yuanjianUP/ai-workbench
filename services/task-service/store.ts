import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';

type FeedbackKind = 'comment' | 'reply' | 'pull_request';

export class TaskStore {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, text TEXT NOT NULL, source TEXT NOT NULL,
      created_at TEXT NOT NULL, status TEXT NOT NULL
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS imports (
      digest TEXT PRIMARY KEY, imported_at TEXT NOT NULL
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS source_events (
      source TEXT NOT NULL, event_id TEXT NOT NULL, task_id TEXT NOT NULL,
      PRIMARY KEY (source, event_id)
    ); CREATE TABLE IF NOT EXISTS event_audit (
      source TEXT NOT NULL, event_id TEXT NOT NULL, sender TEXT NOT NULL,
      outcome TEXT NOT NULL, recorded_at TEXT NOT NULL
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS source_context (
      task_id TEXT PRIMARY KEY, source TEXT NOT NULL, context TEXT NOT NULL
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS feedback (
      operation_key TEXT PRIMARY KEY, task_id TEXT NOT NULL, kind TEXT NOT NULL,
      status TEXT NOT NULL, updated_at TEXT NOT NULL, payload_digest TEXT
    )`);
    const hasPayloadDigest = () => this.db.prepare('PRAGMA table_info(feedback)').all().some(column => column.name === 'payload_digest');
    if (!hasPayloadDigest()) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        if (!hasPayloadDigest()) this.db.exec('ALTER TABLE feedback ADD COLUMN payload_digest TEXT');
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
    this.db.exec(`CREATE TABLE IF NOT EXISTS feedback_authorization_audit (
      operation_key TEXT NOT NULL, task_id TEXT NOT NULL, kind TEXT NOT NULL,
      decision TEXT NOT NULL, recorded_at TEXT NOT NULL
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS feedback_rules (
      task_id TEXT NOT NULL, kind TEXT NOT NULL, decision TEXT NOT NULL,
      updated_at TEXT NOT NULL, PRIMARY KEY (task_id, kind)
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS executions (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, workspace TEXT NOT NULL,
      agent TEXT NOT NULL, orca_id TEXT, state TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS execution_reviews (
      execution_id TEXT PRIMARY KEY, note TEXT NOT NULL, reviewed_at TEXT NOT NULL
    )`);
  }

  create(text: string) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('任务内容不能为空');
    const task = { id: randomUUID(), text: text.trim(), source: 'manual', createdAt: new Date().toISOString(), status: 'pending' };
    this.db.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?, ?)').run(task.id, task.text, task.source, task.createdAt, task.status);
    return task;
  }

  list() {
    return this.db.prepare('SELECT id, text, source, created_at AS createdAt, status FROM tasks ORDER BY created_at DESC, rowid DESC').all();
  }

  get(id: string) {
    return this.db.prepare('SELECT id, text, source, created_at AS createdAt, status FROM tasks WHERE id = ?').get(id);
  }

  // Only a source-specific adapter may assert verification; this is not an HTTP API.
  ingestEvent(event: { source: 'github' | 'feishu'; id: string; sender: string; text: string; context?: Record<string, string | number> }, verified: boolean, allowedSenders: string[]) {
    if (!event || !['github', 'feishu'].includes(event.source) || typeof event.id !== 'string' || !event.id.trim() || typeof event.sender !== 'string' || !event.sender.trim() || typeof event.text !== 'string' || !event.text.trim()) throw new Error('来源事件格式不正确');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const prior = this.db.prepare('SELECT task_id FROM source_events WHERE source = ? AND event_id = ?').get(event.source, event.id);
      const outcome = !verified ? 'invalid' : !allowedSenders.includes(event.sender) ? 'unauthorized' : prior ? 'duplicate' : 'accepted';
      let taskId: string | undefined;
      if (outcome === 'accepted') {
        taskId = randomUUID();
        this.db.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?, ?)').run(taskId, event.text.trim(), event.source, new Date().toISOString(), 'pending');
        this.db.prepare('INSERT INTO source_events VALUES (?, ?, ?)').run(event.source, event.id, taskId);
        if (event.context) this.db.prepare('INSERT INTO source_context VALUES (?, ?, ?)').run(taskId, event.source, JSON.stringify(event.context));
      }
      this.db.prepare('INSERT INTO event_audit VALUES (?, ?, ?, ?, ?)').run(event.source, event.id, event.sender, outcome, new Date().toISOString());
      this.db.exec('COMMIT');
      return { outcome, taskId: taskId ?? (outcome === 'duplicate' ? prior?.task_id : undefined) };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  eventAudit() { return this.db.prepare('SELECT source, event_id AS eventId, sender, outcome, recorded_at AS recordedAt FROM event_audit ORDER BY rowid').all(); }

  sourceContext(taskId: string) {
    const row = this.db.prepare('SELECT source, context FROM source_context WHERE task_id = ?').get(taskId);
    return row ? { source: row.source as string, context: JSON.parse(row.context as string) } : undefined;
  }

  setFeedbackRule(taskId: string, kind: FeedbackKind, decision: 'allow' | 'deny') {
    if (!this.get(taskId) || !['comment', 'reply', 'pull_request'].includes(kind) || !['allow', 'deny'].includes(decision)) throw new Error('反馈规则无效');
    this.db.prepare(`INSERT INTO feedback_rules VALUES (?, ?, ?, ?)
      ON CONFLICT (task_id, kind) DO UPDATE SET decision = excluded.decision, updated_at = excluded.updated_at`)
      .run(taskId, kind, decision, new Date().toISOString());
  }

  feedbackRules() { return this.db.prepare('SELECT task_id AS taskId, kind, decision, updated_at AS updatedAt FROM feedback_rules ORDER BY task_id, kind').all(); }

  async sendFeedback(operationKey: string, taskId: string, kind: FeedbackKind, send: () => Promise<void>, payloadDigest: string | null = null) {
    if (!operationKey.trim() || !this.get(taskId) || !['comment', 'reply', 'pull_request'].includes(kind)) throw new Error('反馈操作无效');
    const rule = this.db.prepare('SELECT decision FROM feedback_rules WHERE task_id = ? AND kind = ?').get(taskId, kind);
    const allowed = rule?.decision === 'allow';
    this.db.prepare('INSERT INTO feedback_authorization_audit VALUES (?, ?, ?, ?, ?)').run(operationKey, taskId, kind, allowed ? 'allow' : 'deny', new Date().toISOString());
    if (!allowed) return { attempted: false, status: 'denied' };
    const now = new Date().toISOString();
    const inserted = this.db.prepare('INSERT OR IGNORE INTO feedback (operation_key, task_id, kind, status, updated_at, payload_digest) VALUES (?, ?, ?, ?, ?, ?)').run(operationKey, taskId, kind, 'unknown', now, payloadDigest);
    if (!inserted.changes) {
      const existing = this.db.prepare('SELECT task_id, kind, status, payload_digest FROM feedback WHERE operation_key = ?').get(operationKey);
      if (!existing || existing.task_id !== taskId || existing.kind !== kind || existing.payload_digest !== payloadDigest) throw new Error('反馈操作标识冲突');
      return { attempted: false, status: existing.status };
    }
    try {
      await send();
      this.db.prepare("UPDATE feedback SET status = 'sent', updated_at = ? WHERE operation_key = ?").run(new Date().toISOString(), operationKey);
      return { attempted: true, status: 'sent' };
    } catch {
      return { attempted: true, status: 'unknown' };
    }
  }

  feedbackAudit() { return this.db.prepare('SELECT operation_key AS operationKey, task_id AS taskId, kind, status, updated_at AS updatedAt FROM feedback ORDER BY rowid').all(); }
  feedbackAuthorizationAudit() { return this.db.prepare('SELECT operation_key AS operationKey, task_id AS taskId, kind, decision, recorded_at AS recordedAt FROM feedback_authorization_audit ORDER BY rowid').all(); }

  beginExecution(taskId: string, workspace: string, agent: string) {
    if (!this.get(taskId) || !workspace.trim() || !agent.trim()) throw new Error('执行信息无效');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.db.prepare("SELECT 1 FROM executions WHERE task_id = ? AND state = 'unknown' LIMIT 1").get(taskId)) {
        throw new Error('任务已有状态未知的执行记录，必须先核对');
      }
      const id = randomUUID();
      this.db.prepare('INSERT INTO executions VALUES (?, ?, ?, ?, NULL, ?, ?)').run(id, taskId, workspace, agent, 'unknown', new Date().toISOString());
      this.db.exec('COMMIT');
      return id;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  attachExecution(id: string, orcaId: string) {
    if (!orcaId.trim()) throw new Error('Orca 标识不能为空');
    const result = this.db.prepare('UPDATE executions SET orca_id = ?, updated_at = ? WHERE id = ? AND orca_id IS NULL').run(orcaId, new Date().toISOString(), id);
    if (!result.changes) throw new Error('执行记录不存在或已有 Orca 标识');
  }

  executions() { return this.db.prepare('SELECT id, task_id AS taskId, workspace, agent, orca_id AS orcaId, state, updated_at AS updatedAt FROM executions ORDER BY rowid').all(); }

  reviewExecution(id: string, note: string) {
    if (!id.trim() || !note.trim()) throw new Error('执行标识和人工核对说明不能为空');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const now = new Date().toISOString();
      const updated = this.db.prepare("UPDATE executions SET state = 'manually_checked', updated_at = ? WHERE id = ? AND state = 'unknown'").run(now, id);
      if (!updated.changes) throw new Error('执行记录不存在或已核对');
      this.db.prepare('INSERT INTO execution_reviews VALUES (?, ?, ?)').run(id, note.trim(), now);
      this.db.exec('COMMIT');
      return { id, state: 'manually_checked', note: note.trim(), reviewedAt: now };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  executionReviews() { return this.db.prepare('SELECT execution_id AS executionId, note, reviewed_at AS reviewedAt FROM execution_reviews ORDER BY rowid').all(); }

  importPrototype(json: string, confirmed: boolean) {
    const data: unknown = JSON.parse(json);
    if (!Array.isArray(data) || data.some(item => !item || typeof item.text !== 'string' || !item.text.trim() || typeof item.createdAt !== 'string' || Number.isNaN(Date.parse(item.createdAt)))) {
      throw new Error('原型任务数据格式不正确');
    }
    const digest = createHash('sha256').update(json).digest('hex');
    const alreadyImported = !!this.db.prepare('SELECT digest FROM imports WHERE digest = ?').get(digest);
    if (!confirmed || alreadyImported) return { count: data.length, alreadyImported, imported: false };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const insert = this.db.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?, ?)');
      for (const item of data) insert.run(randomUUID(), item.text.trim(), 'manual', item.createdAt, 'pending');
      this.db.prepare('INSERT INTO imports VALUES (?, ?)').run(digest, new Date().toISOString());
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { count: data.length, alreadyImported: false, imported: true };
  }

  close() { this.db.close(); }
}
