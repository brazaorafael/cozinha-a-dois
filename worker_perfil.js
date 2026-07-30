/**
 * Cozinha a Dois — módulo de gosto, refeições cozinhadas e exportação.
 *
 * Este arquivo é independente do worker.js: ele só acrescenta funções que o
 * worker.js passa a chamar. Nenhum comportamento existente é alterado.
 *
 * O que ele faz:
 *   - normaliza quem votou (ana | rafael | ambos);
 *   - registra que uma receita foi realmente cozinhada;
 *   - monta o perfil de preferências do casal para o GitHub Actions;
 *   - exporta o banco inteiro para backup.
 *
 * REGRA IMPORTANTE DESTE ARQUIVO — pontuação por tipo de prato.
 * Gostar de um guacamole de entrada não é gostar de comida vegetariana, e
 * gostar de um mousse não é querer sobremesa no jantar. Por isso as tags são
 * contadas separadamente para principal, entrada e sobremesa. Somar tudo junto
 * faz o perfil derivar para o lado errado sem que ninguém perceba.
 *
 * As rotas de perfil e exportação exigem o segredo APP_TOKEN e não são usadas
 * pelo aplicativo no celular.
 */

const VOTERS = ["ana", "rafael", "ambos"];
const COURSES = ["principal", "entrada", "sobremesa"];
const COURSE_LABELS = {
  principal: "Pratos principais",
  entrada: "Entradas",
  sobremesa: "Sobremesas",
  outros: "Sem tipo identificado",
};

/** Aceita qualquer coisa e devolve sempre um votante válido. */
export function normalizeVoter(value) {
  const voter = String(value || "").trim().toLowerCase();
  return VOTERS.includes(voter) ? voter : "ambos";
}

/** Aceita qualquer coisa e devolve principal, entrada, sobremesa ou outros. */
function normalizeCourse(value) {
  const course = String(value || "").trim().toLowerCase();
  return COURSES.includes(course) ? course : "outros";
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
 * É idempotente: pode rodar quantas vezes for. Os ALTER falham em silêncio
 * quando a coluna já existe, que é o caso normal.
 */
let extrasReady = false;
export async function ensureExtras(env) {
  if (!env.DB) throw new Error("banco indisponível");
  if (extrasReady) return true;

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS cooked (
      cooked_id  TEXT PRIMARY KEY,
      recipe_id  TEXT NOT NULL,
      titulo     TEXT NOT NULL,
      tags       TEXT NOT NULL DEFAULT '[]',
      curso      TEXT NOT NULL DEFAULT 'principal',
      cooked_on  TEXT NOT NULL,
      quem       TEXT NOT NULL DEFAULT 'ambos',
      nota       INTEGER,
      observacao TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  for (const alteracao of [
    "ALTER TABLE taste_events ADD COLUMN voter_id TEXT NOT NULL DEFAULT 'ambos'",
    "ALTER TABLE cooked ADD COLUMN curso TEXT NOT NULL DEFAULT 'principal'",
  ]) {
    try {
      await env.DB.prepare(alteracao).run();
    } catch {
      // A coluna já existe.
    }
  }

  await env.DB.prepare(
    "CREATE INDEX IF NOT EXISTS idx_cooked_on ON cooked(cooked_on)",
  ).run();

  extrasReady = true;
  return true;
}

function requireToken(body, env) {
  const expected = String(env.APP_TOKEN || "").trim();
  if (!expected) throw new Error("APP_TOKEN não está configurado no Worker");
  const received = String(body?.token || "").trim();
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
  const tags = parseTags(recipe.tags);
  const curso = normalizeCourse(recipe.curso || body.curso);
  const cookedOn = /^\d{4}-\d{2}-\d{2}$/.test(String(body.data || ""))
    ? body.data
    : todayInSaoPaulo();
  const quem = normalizeVoter(body.quem);
  const nota = Number.isInteger(body.nota) && body.nota >= 1 && body.nota <= 5 ? body.nota : null;
  const observacao = body.observacao ? safeText(body.observacao, 400) : null;
  const cookedId = `${recipeId}:${cookedOn}`;

  await env.DB.prepare(`
    INSERT INTO cooked (cooked_id, recipe_id, titulo, tags, curso, cooked_on, quem, nota, observacao)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(cooked_id) DO UPDATE SET
      titulo = excluded.titulo,
      tags = excluded.tags,
      curso = excluded.curso,
      quem = excluded.quem,
      nota = excluded.nota,
      observacao = excluded.observacao
  `).bind(
    cookedId, recipeId, titulo, JSON.stringify(tags), curso, cookedOn, quem, nota, observacao,
  ).run();

  return { ok: true, cooked_id: cookedId, cooked_on: cookedOn, curso };
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
    SELECT cooked_id, recipe_id, titulo, tags, curso, cooked_on, quem, nota
    FROM cooked
    ORDER BY cooked_on DESC
    LIMIT 80
  `).all();

  const pessoas = {
    ana: { gostou: [], rejeitou: [] },
    rafael: { gostou: [], rejeitou: [] },
    ambos: { gostou: [], rejeitou: [] },
  };

  // Uma conta de pontos por tipo de prato — nunca uma conta só.
  const pontos = { principal: new Map(), entrada: new Map(), sobremesa: new Map(), outros: new Map() };
  const somarTags = (curso, tags, valor) => {
    const conta = pontos[curso] || pontos.outros;
    for (const tag of tags) conta.set(tag, (conta.get(tag) || 0) + valor);
  };

  const vistos = new Set();
  for (const evento of eventos.results || []) {
    const chave = `${evento.recipe_id}|${evento.voter_id}`;
    if (vistos.has(chave)) continue;
    vistos.add(chave);

    const receita = recipeFromJson(evento.recipe_json);
    const titulo = safeText(receita.nome, 200) || evento.recipe_id;
    const tags = parseTags(receita.tags);
    const curso = normalizeCourse(receita.curso);
    const quem = normalizeVoter(evento.voter_id);
    const item = { titulo, tags, curso };

    if (evento.vote === "like") {
      pessoas[quem].gostou.push(item);
      somarTags(curso, tags, quem === "ambos" ? 2 : 1);
    } else if (evento.vote === "dislike") {
      pessoas[quem].rejeitou.push(item);
      somarTags(curso, tags, quem === "ambos" ? -2 : -1);
    }
  }

  const cozinhadosRecentes = [];
  const naoRepetir = [];
  for (const linha of cozinhados.results || []) {
    const diasAtras = daysBetween(linha.cooked_on, hoje);
    const tags = parseTags(linha.tags);
    const curso = normalizeCourse(linha.curso);
    cozinhadosRecentes.push({
      titulo: linha.titulo,
      curso,
      cooked_on: linha.cooked_on,
      dias_atras: diasAtras,
      nota: linha.nota,
      tags,
    });
    if (diasAtras !== null && diasAtras <= janelaDias) naoRepetir.push(linha.titulo);
    if (Number.isInteger(linha.nota) && linha.nota !== 3) {
      somarTags(curso, tags, linha.nota >= 4 ? 2 : -2);
    }
  }

  const ordenar = (conta, positivo) =>
    [...conta.entries()]
      .filter(([, valor]) => (positivo ? valor > 0 : valor < 0))
      .sort((a, b) => (positivo ? b[1] - a[1] : a[1] - b[1]))
      .slice(0, 10)
      .map(([tag, valor]) => ({ tag, pontos: valor }));

  const tagsFavoritas = {};
  const tagsEvitar = {};
  for (const curso of [...COURSES, "outros"]) {
    tagsFavoritas[curso] = ordenar(pontos[curso], true);
    tagsEvitar[curso] = ordenar(pontos[curso], false);
  }

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
  const sujeitos = {
    ambos: ["Os dois gostaram de", "Os dois não gostaram de"],
    ana: ["Ana gostou de", "Ana não gostou de"],
    rafael: ["Rafael gostou de", "Rafael não gostou de"],
  };

  const listar = (itens) =>
    itens
      .slice(0, 15)
      .map((item) => `${item.titulo} (${item.curso})`)
      .join("; ");

  for (const quem of ["ambos", "ana", "rafael"]) {
    if (pessoas[quem].gostou.length) {
      partes.push(`${sujeitos[quem][0]}: ${listar(pessoas[quem].gostou)}.`);
    }
  }
  for (const quem of ["ambos", "ana", "rafael"]) {
    if (pessoas[quem].rejeitou.length) {
      partes.push(`${sujeitos[quem][1]}: ${listar(pessoas[quem].rejeitou)}.`);
    }
  }

  const porCurso = [];
  for (const curso of COURSES) {
    const bons = (tagsFavoritas[curso] || []).map((t) => t.tag);
    const ruins = (tagsEvitar[curso] || []).map((t) => t.tag);
    if (!bons.length && !ruins.length) continue;
    const trechos = [];
    if (bons.length) trechos.push(`aprovadas: ${bons.join(", ")}`);
    if (ruins.length) trechos.push(`reprovadas: ${ruins.join(", ")}`);
    porCurso.push(`${COURSE_LABELS[curso]} — ${trechos.join("; ")}`);
  }
  if (porCurso.length) {
    partes.push(
      "Características avaliadas SEPARADAMENTE por tipo de prato. " +
        "Não transfira a preferência de um tipo para outro: gostar de uma entrada " +
        "vegetariana não significa querer prato principal vegetariano, e gostar de " +
        "uma sobremesa doce não diz nada sobre o jantar. " +
        porCurso.join(". ") + ".",
    );
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
