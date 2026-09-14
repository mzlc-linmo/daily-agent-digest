-- D1 审计日志:提交、签发、撤销都留痕(持久化,可查询)。
-- 应用方式:npx wrangler d1 execute daily-agent-digest-logs --remote --file=schema.sql
--
-- 设计说明:
--   · 每次提交都写一行(成功与失败都写),失败不再只存在于 Workers Logs 里;
--   · event 区分事件类型,一张表覆盖提交与密钥操作,便于按人/按天审计;
--   · detail 放不适合单独建列的附加信息(JSON 字符串),避免频繁改表结构。

CREATE TABLE IF NOT EXISTS audit_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ts             TEXT    NOT NULL,           -- ISO8601(UTC)
  event          TEXT    NOT NULL,           -- submit | issue_key | revoke_key | bootstrap
  request_id     TEXT,
  key_id         TEXT,
  member         TEXT,
  member_id      TEXT,
  date           TEXT,                       -- 日报归属日期 YYYY-MM-DD
  mode           TEXT,                       -- created | updated | unchanged
  items          INTEGER,
  report_chars   INTEGER,
  duration_ms    INTEGER,
  outcome        TEXT    NOT NULL,           -- ok | error
  error_code     TEXT,
  error_message  TEXT,
  release_version TEXT,
  user_agent     TEXT,
  country        TEXT,
  detail         TEXT                        -- JSON
);

CREATE INDEX IF NOT EXISTS idx_audit_ts        ON audit_log (ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_member    ON audit_log (member_id, date);
CREATE INDEX IF NOT EXISTS idx_audit_event     ON audit_log (event, ts DESC);
