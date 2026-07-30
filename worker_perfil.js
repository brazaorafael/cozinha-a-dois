/**
 * Cozinha a Dois — módulo de gosto, refeições cozinhadas e exportação.
 *
 * Este arquivo é NOVO e independente. Ele não altera nenhum comportamento
 * existente do Worker: só acrescenta funções que o worker.js passa a chamar.
 *
 * O que ele faz:
 *   - normaliza quem votou (ana | rafael | ambos);
 *   - registra que uma receita foi realmente cozinhada;
 *   - monta o perfil de preferências do casal para o GitHub Actions;
 *   - exporta o banco inteiro para backup.
 *
 * As duas últimas rotas exigem o segredo APP_TOKEN, configurado no painel do
 * Cloudflare. Elas não são usadas pelo aplicativo no celular.
 */

const VOTERS = ["ana", "rafael", "ambos"];

/** Aceita qualquer coisa e devolve sempre um votante válido. */
export function normalizeVoter(value) {
  const voter = String(value || "").trim().toLowerCase();
  return VOTERS.includes(voter) ? voter : "ambos";
}

/** Data de hoje em São Paulo, no formato AAAA-MM-DD. */
function todayInSaoPaulo() {
  return new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function daysBetween(isoDate, reference) {
  const a = Date.parse(`${isoDate}T12:00:00Z`);
  const b = Date.parse(`${reference}T12:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

function safeText(value, max) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function parseTags(value) {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((tag) => safeText(tag, 40).toLowerCase()).filter(Boolean).slice(0, 8);
  } catch {
    return [];
  }
}

function recipeFromJson(value) {
  try {
    return typeof value === "string" ? JSON.parse(value) : value || {};
  } catch {
    return {};
  }
}

/**
 * Garante a estrutura que este módulo usa, sem depender do worker.js.
 * É idempotente: pode rodar quantas vezes for.
 */
let extrasReady = false;
export async function ensureExtras(env) {
  if (!env.DB) throw new Error("banco indisponível");
  if (extrasReady) return true;
  try {
    await env.DB.prepare(
      "ALTER TABLE taste_events ADD COLUMN voter_id TEXT NOT NULL DEFAULT 'ambos'",
    ).run();
  } catch {
    // A coluna já existe. É o caso normal.
  }
  await env.DB.prepare(`
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
    )
  `).run();
  await env.DB.prepare(
    "CREATE INDEX IF NOT EXISTS idx_cooked_on ON cooked(cooked_on)",
  ).run();
  extrasReady = true;
  return true;
}

function requireToken(body, env) {
  const expected = String(env.APP_TOKEN || "");
  if (!expected) throw new Error("APP_TOKEN não está configurado no Worker");
  const received = String(body?.token || "");
  if (received !== expected) throw new Error("token inválido");
}

/* ------------------------------------------------------------------------ */
/* Registrar que a receita foi cozinhada                                     */
/* ------------------------------------------------------------------------ */

/**
 * O identificador é receita + data, então marcar "cozinhamos" duas vezes no
 * mesmo dia corrige o registro em vez de duplicar.
 */
export async function handleCooked(body, env) {
  await ensureExtras(env);

  const recipe = body.receita || {};
  const recipeId = safeText(recipe.id || body.recipe_id, 160);
  if (!recipeId) throw new Error("receita sem id");

  const titulo = safeText(recipe.nome || body.titulo, 200) || recipeId;
  const tags = Array.isArray(recipe.tags) ? parseTags(recipe.tags) : [];
  const cookedOn = /^\d{4}-\d{2}-\d{2}$/.test(String(body.data || ""))
    ? body.data
    : todayInSaoPaulo();
  const quem = normalizeVoter(body.quem);
  const nota = Number.isInteger(body.nota) && body.nota >= 1 && body.nota <= 5 ? body.nota : null;
  const observacao = body.observacao ? safeText(body.observacao, 400) : null;
  const cookedId = `${recipeId}:${cookedOn}`;

  await env.DB.prepare(`
    INSERT INTO cooked (cooked_id, recipe_id, titulo, tags, cooked_on, quem, nota, observacao)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(cooked_id) DO UPDATE SET
      titulo = excluded.titulo,
      tags = excluded.tags,
      quem = excluded.quem,
      nota = excluded.nota,
      observacao = excluded.observacao
  `).bind(cookedId, recipeId, titulo, JSON.stringify(tags), cookedOn, quem, nota, observacao).run();

  return { ok: true, cooked_id: cookedId, cooked_on: cookedOn };
}

/** Remove o registro, caso tenha sido marcado por engano. */
export async function handleUncooked(body, env) {
  await ensureExtras(env);
  const cookedId = safeText(body.cooked_id, 200);
  if (!cookedId) throw new Error("cooked_id ausente");
  await env.DB.prepare("DELETE FROM cooked WHERE cooked_id = ?").bind(cookedId).run();
  return { ok: true };
}

/* ------------------------------------------------------------------------ */
/* Perfil de preferências                                                    */
/* ------------------------------------------------------------------------ */

/**
 * Regra central: taste_events é um histórico, não um placar.
 * Para cada par (receita, pessoa) vale APENAS o evento mais recente.
 * Curtir hoje e descurtir amanhã deixa as duas linhas no banco, mas só a
 * segunda conta.
 */
export async function handlePerfil(body, env) {
  requireToken(body, env);
  await ensureExtras(env);

  const hoje = todayInSaoPaulo();
  const janelaDias = Number.isInteger(body.janela_dias) ? body.janela_dias : 21;

  const eventos = await env.DB.prepare(`
    SELECT t.recipe_id, t.voter_id, t.vote, t.created_at, f.recipe_json
    FROM taste_events t
    JOIN (
      SELECT recipe_id, voter_id, MAX(created_at) AS ultimo
      FROM taste_events
      GROUP BY recipe_id, voter_id
    ) atual
      ON atual.recipe_id = t.recipe_id
     AND atual.voter_id = t.voter_id
     AND atual.ultimo = t.created_at
    LEFT JOIN favorites f ON f.recipe_id = t.recipe_id
    ORDER BY t.created_at DESC
    LIMIT 500
  `).all();

  const cozinhados = await env.DB.prepare(`
    SELECT cooked_id, recipe_id, titulo, tags, cooked_on, quem, nota
    FROM cooked
    ORDER BY cooked_on DESC
    LIMIT 80
  `).all();

  const pessoas = {
    ana: { gostou: [], rejeitou: [] },
    rafael: { gostou: [], rejeitou: [] },
    ambos: { gostou: [], rejeitou: [] },
  };
  const pontosPorTag = new Map();
  const vistos = new Set();

  const somarTags = (tags, pontos) => {
    for (const tag of tags) {
      pontosPorTag.set(tag, (pontosPorTag.get(tag) || 0) + pontos);
    }
  };

  for (const evento of eventos.results || []) {
    const chave = `${evento.recipe_id}|${evento.voter_id}`;
    if (vistos.has(chave)) continue;
    vistos.add(chave);

    const receita = recipeFromJson(evento.recipe_json);
    const titulo = safeText(receita.nome, 200) || evento.recipe_id;
    const tags = parseTags(receita.tags);
    const quem = normalizeVoter(evento.voter_id);
    const item = { titulo, tags };

    if (evento.vote === "like") {
      pessoas[quem].gostou.push(item);
      somarTags(tags, quem === "ambos" ? 2 : 1);
    } else if (evento.vote === "dislike") {
      pessoas[quem].rejeitou.push(item);
      somarTags(tags, quem === "ambos" ? -2 : -1);
    }
  }

  const cozinhadosRecentes = [];
  const naoRepetir = [];
  for (const linha of cozinhados.results || []) {
    const diasAtras = daysBetween(linha.cooked_on, hoje);
    const tags = parseTags(linha.tags);
    cozinhadosRecentes.push({
      titulo: linha.titulo,
      cooked_on: linha.cooked_on,
      dias_atras: diasAtras,
      nota: linha.nota,
      tags,
    });
    if (diasAtras !== null && diasAtras <= janelaDias) naoRepetir.push(linha.titulo);
    if (Number.isInteger(linha.nota)) somarTags(tags, linha.nota >= 4 ? 2 : linha.nota <= 2 ? -2 : 0);
  }

  const tagsFavoritas = [...pontosPorTag.entries()]
    .filter(([, pontos]) => pontos > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([tag, pontos]) => ({ tag, pontos }));

  const tagsEvitar = [...pontosPorTag.entries()]
    .filter(([, pontos]) => pontos < 0)
    .sort((a, b) => a[1] - b[1])
    .slice(0, 8)
    .map(([tag, pontos]) => ({ tag, pontos }));

  return {
    ok: true,
    gerado_em: new Date().toISOString(),
    janela_dias: janelaDias,
    pessoas,
    tags_favoritas: tagsFavoritas,
    tags_evitar: tagsEvitar,
    cozinhados_recentes: cozinhadosRecentes,
    nao_repetir: naoRepetir,
    resumo: montarResumo(pessoas, tagsFavoritas, tagsEvitar, naoRepetir, janelaDias),
  };
}

/**
 * Texto curto e determinístico, pronto para ser colado no prompt do gerador.
 * Deixa o refeicoes_agent.py simples: ele só precisa ler este campo.
 */
function montarResumo(pessoas, tagsFavoritas, tagsEvitar, naoRepetir, janelaDias) {
  const partes = [];
  const nomes = { ana: "Ana", rafael: "Rafael", ambos: "Os dois juntos" };

  for (const chave of ["ambos", "ana", "rafael"]) {
    const gostou = pessoas[chave].gostou.map((item) => item.titulo).slice(0, 15);
    if (gostou.length) partes.push(`${nomes[chave]} gostou de: ${gostou.join("; ")}.`);
  }
  for (const chave of ["ambos", "ana", "rafael"]) {
    const rejeitou = pessoas[chave].rejeitou.map((item) => item.titulo).slice(0, 15);
    if (rejeitou.length) partes.push(`${nomes[chave]} não gostou de: ${rejeitou.join("; ")}.`);
  }
  if (tagsFavoritas.length) {
    partes.push(`Características bem avaliadas: ${tagsFavoritas.map((t) => t.tag).join(", ")}.`);
  }
  if (tagsEvitar.length) {
    partes.push(`Características mal avaliadas: ${tagsEvitar.map((t) => t.tag).join(", ")}.`);
  }
  if (naoRepetir.length) {
    partes.push(
      `Já cozinhado nos últimos ${janelaDias} dias, não repetir: ${naoRepetir.slice(0, 30).join("; ")}.`,
    );
  }
  return partes.join(" ") || "Ainda não há preferências registradas.";
}

/* ------------------------------------------------------------------------ */
/* Exportação para backup                                                    */
/* ------------------------------------------------------------------------ */

export async function handleExport(body, env) {
  requireToken(body, env);
  await ensureExtras(env);

  const [favorites, tasteEvents, cooked, appState] = await Promise.all([
    env.DB.prepare("SELECT * FROM favorites ORDER BY created_at").all(),
    env.DB.prepare("SELECT * FROM taste_events ORDER BY created_at").all(),
    env.DB.prepare("SELECT * FROM cooked ORDER BY cooked_on").all(),
    env.DB.prepare("SELECT * FROM app_state").all(),
  ]);

  return {
    ok: true,
    exportado_em: new Date().toISOString(),
    tabelas: {
      favorites: favorites.results || [],
      taste_events: tasteEvents.results || [],
      cooked: cooked.results || [],
      app_state: appState.results || [],
    },
    contagem: {
      favorites: (favorites.results || []).length,
      taste_events: (tasteEvents.results || []).length,
      cooked: (cooked.results || []).length,
      app_state: (appState.results || []).length,
    },
  };
}
