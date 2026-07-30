-- Cozinha a Dois — estrutura do Cloudflare D1
--
-- O Worker cria estas tabelas automaticamente no primeiro uso.
-- Este arquivo serve para consulta e para inicialização manual no console do D1.
--
-- Regra do projeto: as alterações são sempre ADITIVAS.
-- Nenhuma coluna ou tabela é renomeada ou removida, para que uma versão
-- anterior do Worker continue funcionando enquanto a nova não é publicada.
 
-- ---------------------------------------------------------------------------
-- Favoritos: o "caderno de receitas" do casal.
-- É um estado de casal, não de pessoa. A preferência individual fica em
-- taste_events; aqui ficam apenas as receitas que entraram no caderno.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS favorites (
  recipe_id   TEXT PRIMARY KEY,
  recipe_json TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'vote',
  photo_key   TEXT,
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
 
-- ---------------------------------------------------------------------------
-- Eventos de gosto: um registro histórico, não um placar.
-- Cada clique gera uma linha nova. Para saber a opinião atual sobre uma
-- receita, vale SEMPRE o evento mais recente daquela pessoa — nunca a soma.
--
-- voter_id: 'ana', 'rafael' ou 'ambos'.
-- Todos os votos anteriores a esta mudança valem como 'ambos', que é
-- exatamente o que eles significavam quando foram registrados.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS taste_events (
  event_id   TEXT PRIMARY KEY,
  recipe_id  TEXT NOT NULL,
  vote       TEXT NOT NULL,
  voter_id   TEXT NOT NULL DEFAULT 'ambos',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
 
-- ---------------------------------------------------------------------------
-- Refeições realmente cozinhadas.
--
-- Esta tabela existe para separar "foi sugerido" de "nós comemos".
-- Hoje o gerador evita repetir pratos que apenas apareceram no cardápio,
-- incluindo as 28 receitas semanais que ninguém preparou — e por isso vai
-- se auto-bloqueando com o tempo. A partir daqui, "evitar repetição"
-- passa a olhar para o que está aqui dentro.
--
-- cooked_on x created_at: 'cooked_on' é a data do jantar; 'created_at' é o
-- momento em que o registro foi feito. São diferentes quando vocês marcam
-- na manhã seguinte, e o que importa para não repetir é a data do jantar.
--
-- tags guarda um JSON simples, por exemplo: ["carne","forno","rapido"]
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cooked (
  cooked_id  TEXT PRIMARY KEY,
  recipe_id  TEXT NOT NULL,
  titulo     TEXT NOT NULL,
  tags       TEXT NOT NULL DEFAULT '[]',
  cooked_on  TEXT NOT NULL,
  quem       TEXT NOT NULL DEFAULT 'ambos',
  nota       INTEGER,
  observacao TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
 
-- ---------------------------------------------------------------------------
-- Estado da aplicação (hoje: a lista de compras).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_state (
  state_key  TEXT PRIMARY KEY,
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
 
-- ---------------------------------------------------------------------------
-- Índices
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_favorites_updated_at
  ON favorites(updated_at);
 
CREATE INDEX IF NOT EXISTS idx_taste_events_recipe
  ON taste_events(recipe_id);
 
CREATE INDEX IF NOT EXISTS idx_taste_events_voter
  ON taste_events(voter_id, created_at);
 
CREATE INDEX IF NOT EXISTS idx_cooked_on
  ON cooked(cooked_on);
 
CREATE INDEX IF NOT EXISTS idx_cooked_recipe
  ON cooked(recipe_id);
