CREATE TABLE checkins (
  email TEXT NOT NULL,
  date TEXT NOT NULL,        -- KST 기준 YYYY-MM-DD
  created_at INTEGER NOT NULL,
  PRIMARY KEY (email, date)
);
CREATE INDEX idx_checkins_email ON checkins(email);
