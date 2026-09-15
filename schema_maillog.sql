-- 아침 메일 발송 결과 기록. "메일이 안 왔다"를 추적할 수 있게 하는 것이 목적.
CREATE TABLE IF NOT EXISTS mail_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  date       TEXT NOT NULL,          -- KST 기준 YYYY-MM-DD
  email      TEXT NOT NULL,
  status     TEXT NOT NULL,          -- ok | fail
  detail     TEXT,                   -- 실패 사유 (길이 제한해서 저장)
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mail_log_date ON mail_log(date);
