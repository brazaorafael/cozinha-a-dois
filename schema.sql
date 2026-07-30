-- O Worker cria estas tabelas automaticamente no primeiro uso.
-- Este arquivo serve para consulta ou para inicialização manual no console do D1.

CREATE TABLE IF NOT EXISTS favorites (
  recipe_id TEXT PRIMARY KEY,
  recipe_json TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'vote',
  photo_key TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS taste_events (
  event_id TEXT PRIMARY KEY,
  recipe_id TEXT NOT NULL,
  vote TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS app_state (
  state_key TEXT PRIMARY KEY,
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_favorites_updated_at
  ON favorites(updated_at);

CREATE INDEX IF NOT EXISTS idx_taste_events_recipe
  ON taste_events(recipe_id);
