/**
 * Cozinha Worker v3
 *
 * Segredos no painel Cloudflare:
 *   GEMINI_API_KEY, GITHUB_TOKEN, PEXELS_KEY (opcional)
 *
 * Variáveis comuns:
 *   REPO="usuario/cozinha-a-dois"
 *   ALLOWED_ORIGINS="https://usuario.github.io,http://localhost:8000"
 *   ALLOWED_RECIPE_HOSTS="panelinha.com.br,receitasnestle.com.br,..."
 *   GEMINI_MODEL="gemini-2.5-flash"
 *
 * Bindings opcionais, mas recomendados:
 *   DB (Cloudflare D1) e PHOTOS (Cloudflare R2)
 */

const DEFAULT_MODEL = "gemini-2.5-flash";
const DEFAULT_SEARCH_MODEL = "gemini-2.5-flash-lite";
const DEFAULT_RECIPE_HOSTS = [
  "panelinha.com.br",
  "receitasnestle.com.br",
  "receitas.globo.com",
  "anamariabraga.globo.com",
  "tudogostoso.com.br",
  "guiadacozinha.com.br",
  "cookpad.com",
  "tudoreceitas.com",
  "cybercook.com.br",
  "tastemade.com.br",
  "naminhapanela.com",
  "receitasdeminuto.com",
  "presuntovegetariano.com.br",
  "daninoce.com.br",
  "amopaocaseiro.com.br",
  "pitadinha.com",
  "pratofundo.com",
  "cozinhalegal.com.br",
];
const SOURCE_TIERS = {
  3: [
    "panelinha.com.br",
    "receitasnestle.com.br",
    "receitas.globo.com",
    "anamariabraga.globo.com",
    "tudogostoso.com.br",
  ],
  2: [
    "guiadacozinha.com.br",
    "cookpad.com",
    "tudoreceitas.com",
    "cybercook.com.br",
    "tastemade.com.br",
  ],
  1: [
    "naminhapanela.com",
    "receitasdeminuto.com",
    "presuntovegetariano.com.br",
    "daninoce.com.br",
    "amopaocaseiro.com.br",
    "pitadinha.com",
    "pratofundo.com",
    "cozinhalegal.com.br",
  ],
};
const SEARCH_TTL_SECONDS = 60 * 60 * 12;
const PENDING_TTL_SECONDS = 90;
const SEARCH_CACHE_VERSION = "v6-panelinha-r2";
// O próprio site do Panelinha usa este índice e esta chave pública somente para leitura.
const PANELINHA_SEARCH_HOST = "lrcfpi14gd2kqnsap-1.a1.typesense.net";
const PANELINHA_SEARCH_KEY = "h4mOKanY7wZS479ZsHGu33J4AtEnfFvP";
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const PROFILE = [
  "Casal jovem, jantar para 2, com sobra para o almoço de 1 quando fizer sentido.",
  "Prioridade em proteína; carne vermelha é a preferida; peixe no máximo 1x por semana.",
  "Pouca fritura. Preferir forno, grelha, airfryer ou refogado.",
  "Receitas práticas, com ingredientes acessíveis no Brasil e até cerca de 45 minutos.",
].join(" ");

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const requestUrl = new URL(request.url);
    if (request.method === "GET" && requestUrl.pathname.startsWith("/media/")) {
      return handleMedia(requestUrl.pathname.slice("/media/".length), env, cors);
    }
    if (request.method === "GET") {
      return respond({
        ok: true,
        servico: "cozinha-a-dois-worker",
        versao: 3,
        banco: Boolean(env.DB),
        fotos: Boolean(env.PHOTOS),
      }, 200, cors);
    }
    if (request.method !== "POST") return respond({ error: "metodo_nao_permitido" }, 405, cors);
    if (!originAllowed(request, env)) return respond({ error: "origem_nao_permitida" }, 403, cors);

    const length = Number(request.headers.get("content-length") || 0);
    if (length > MAX_BODY_BYTES) return respond({ error: "pedido_muito_grande" }, 413, cors);

    let body;
    try {
      body = await request.json();
    } catch {
      return respond({ error: "json_invalido" }, 400, cors);
    }

    try {
      switch (body.action || "voto") {
        case "bootstrap":
          return respond(await handleBootstrap(env), 200, cors);
        case "voto":
          return respond(await handleVote(body, env), 200, cors);
        case "buscar":
        case "com_ingredientes":
          return handleSearch(body, env, ctx, cors);
        case "buscar_status":
          return respond(await readSearchJob(body.job_id), 200, cors);
        case "imagem":
          return respond(await handleImage(body, env), 200, cors);
        case "foto":
          return respond(await handlePhoto(body, env), 200, cors);
        case "foto_receita":
          return respond(await handleRecipePhoto(body, env, requestUrl.origin), 200, cors);
        case "consolidar":
          return respond(await handleConsolidate(body, env), 200, cors);
        case "lista_salvar":
          return respond(await handleSaveShopping(body, env), 200, cors);
        case "acompanhar":
          return respond(await handleSides(body, env), 200, cors);
        default:
          return respond({ error: "acao_desconhecida" }, 400, cors);
      }
    } catch (error) {
      console.error("cozinha_worker_error", {
        action: body.action,
        message: String(error?.message || error),
      });
      return respond({ error: "falha_temporaria", detalhe: safeError(error) }, 502, cors);
    }
  },
};

function respond(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

function corsHeaders(request, env) {
  const origin = request.headers.get("origin") || "";
  const allowed = allowedOrigins(env);
  const reflected = !origin || allowed.includes("*") || allowed.includes(origin) ? origin || "*" : "null";
  return {
    "Access-Control-Allow-Origin": reflected,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || "*")
    .split(",")
    .map((value) => value.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

function originAllowed(request, env) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  const allowed = allowedOrigins(env);
  return allowed.includes("*") || allowed.includes(origin.replace(/\/+$/, ""));
}

function requireSecret(env, key) {
  if (!env[key]) throw new Error(`${key} ausente`);
}

async function ensureDatabase(env) {
  if (!env.DB) return false;
  await env.DB.batch([
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS favorites (
        recipe_id TEXT PRIMARY KEY,
        recipe_json TEXT NOT NULL,
        source_type TEXT NOT NULL DEFAULT 'vote',
        photo_key TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS taste_events (
        event_id TEXT PRIMARY KEY,
        recipe_id TEXT NOT NULL,
        vote TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS app_state (
        state_key TEXT PRIMARY KEY,
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
    env.DB.prepare(`
      CREATE INDEX IF NOT EXISTS idx_favorites_updated_at
      ON favorites(updated_at)
    `),
    env.DB.prepare(`
      CREATE INDEX IF NOT EXISTS idx_taste_events_recipe
      ON taste_events(recipe_id)
    `),
  ]);
  return true;
}

async function handleBootstrap(env) {
  if (!await ensureDatabase(env)) {
    return {
      favorites: [],
      shopping: null,
      storage: "local",
      aviso: "Adicione o binding D1 chamado DB para sincronizar entre aparelhos.",
    };
  }
  let [favoritesResult, shoppingResult] = await Promise.all([
    env.DB.prepare(`
      SELECT recipe_json, updated_at
      FROM favorites
      ORDER BY updated_at DESC
      LIMIT 500
    `).all(),
    env.DB.prepare(`
      SELECT state_json, updated_at
      FROM app_state
      WHERE state_key = 'shopping'
    `).first(),
  ]);
  if (!(favoritesResult.results || []).length) {
    await seedFavoritesFromGitHub(env);
    favoritesResult = await env.DB.prepare(`
      SELECT recipe_json, updated_at
      FROM favorites
      ORDER BY updated_at DESC
      LIMIT 500
    `).all();
  }
  const favorites = (favoritesResult.results || []).flatMap((row) => {
    try {
      return [{ ...JSON.parse(row.recipe_json), saved_at: row.updated_at }];
    } catch {
      return [];
    }
  });
  let shopping = null;
  if (shoppingResult?.state_json) {
    try {
      shopping = {
        ...JSON.parse(shoppingResult.state_json),
        updatedAt: shoppingResult.updated_at,
      };
    } catch {
      shopping = null;
    }
  }
  return { favorites, shopping, storage: "d1" };
}

async function seedFavoritesFromGitHub(env) {
  const repo = String(env.REPO || "").trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return;
  try {
    const headers = {
      "Accept": "application/vnd.github.raw+json",
      "User-Agent": "cozinha-app-worker-v3",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
    const response = await fetch(`https://api.github.com/repos/${repo}/contents/data/lista_final.json`, { headers });
    if (!response.ok) return;
    const payload = await response.json();
    for (const raw of (payload.itens || []).slice(0, 500)) {
      const recipe = sanitizeRecipe(raw);
      if (recipe.id) await saveFavorite(env, recipe, "github_migration");
    }
  } catch {
    // Um banco novo pode começar vazio sem impedir o funcionamento.
  }
}

async function handleMedia(rawKey, env, cors) {
  if (!env.PHOTOS) return respond({ error: "fotos_nao_configuradas" }, 404, cors);
  const key = decodeURIComponent(String(rawKey || ""));
  if (!key || key.includes("..") || key.startsWith("/")) {
    return respond({ error: "arquivo_invalido" }, 400, cors);
  }
  const object = await env.PHOTOS.get(key);
  if (!object) return respond({ error: "arquivo_nao_encontrado" }, 404, cors);
  const headers = new Headers(cors);
  object.writeHttpMetadata(headers);
  headers.set("Cache-Control", "private, max-age=86400");
  headers.set("ETag", object.httpEtag);
  return new Response(object.body, { headers });
}

async function handleVote(body, env) {
  if (!["like", "dislike", "remove"].includes(body.voto)) throw new Error("voto inválido");
  if (!body.receita?.id) throw new Error("receita sem id");
  const recipe = sanitizeRecipe(body.receita);
  const eventId = String(body.event_id || crypto.randomUUID()).slice(0, 180);

  if (await ensureDatabase(env)) {
    await env.DB.prepare(`
      INSERT OR IGNORE INTO taste_events (event_id, recipe_id, vote)
      VALUES (?, ?, ?)
    `).bind(eventId, recipe.id, body.voto).run();
    if (body.voto === "like") {
      await saveFavorite(env, recipe, body.source_type || "vote", body.photo_key || null);
    } else {
      await env.DB.prepare("DELETE FROM favorites WHERE recipe_id = ?").bind(recipe.id).run();
    }
  }

  const githubSynced = await dispatchTasteToGitHub({
    voto: body.voto,
    eventId,
    recipe,
  }, env);
  return {
    ok: true,
    banco: Boolean(env.DB),
    perfil_github: githubSynced,
  };
}

async function saveFavorite(env, recipe, sourceType = "vote", photoKey = null) {
  if (!env.DB) return;
  await env.DB.prepare(`
    INSERT INTO favorites (
      recipe_id, recipe_json, source_type, photo_key, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(recipe_id) DO UPDATE SET
      recipe_json = excluded.recipe_json,
      source_type = excluded.source_type,
      photo_key = COALESCE(excluded.photo_key, favorites.photo_key),
      updated_at = CURRENT_TIMESTAMP
  `).bind(
    recipe.id,
    JSON.stringify(recipe),
    String(sourceType || "vote").slice(0, 40),
    photoKey,
  ).run();
}

async function dispatchTasteToGitHub({ voto, eventId, recipe }, env) {
  const repo = String(env.REPO || "").trim();
  if (!env.GITHUB_TOKEN || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return false;
  try {
    const response = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "cozinha-app-worker-v3",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({
        event_type: "gosto",
        client_payload: {
          voto,
          event_id: eventId,
          receita: recipe,
        },
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function handleSearch(body, env, ctx, cors) {
  const action = body.action;
  const query = action === "com_ingredientes"
    ? (Array.isArray(body.ingredientes) ? body.ingredientes.join(", ") : String(body.texto || ""))
    : String(body.texto || "");
  const clean = query.trim().slice(0, 300);
  if (!clean) return respond({ pratos: [], status: "done" }, 200, cors);

  const jobId = await hashText(`${SEARCH_CACHE_VERSION}:${action}:${normalize(clean)}`);
  const ready = await readSearchJob(jobId);
  if (ready.status === "done") return respond(ready, 200, cors);
  if (ready.status === "processing" && Date.now() - Number(ready.started_at || 0) < 75_000) {
    return respond(ready, 202, cors);
  }

  await writeSearchJob(jobId, { status: "processing", job_id: jobId, started_at: Date.now() }, PENDING_TTL_SECONDS);
  ctx.waitUntil(
    runVerifiedSearch(action, clean, env)
      .then((pratos) => writeSearchJob(jobId, { status: "done", job_id: jobId, pratos }, SEARCH_TTL_SECONDS))
      .catch(async (error) => {
        const detail = safeError(error);
        console.error("search_background_error", { jobId, message: detail });
        await writeSearchJob(jobId, {
          status: "done",
          job_id: jobId,
          pratos: [],
          aviso: detail.includes("Gemini 429")
            ? "A pesquisa atingiu o limite momentâneo do Gemini. Tente novamente em alguns minutos."
            : "A busca não encontrou fontes verificáveis. Tente novamente com o nome do prato.",
        }, 300);
      }),
  );
  return respond({ status: "processing", job_id: jobId }, 202, cors);
}

async function runVerifiedSearch(action, query, env) {
  const intent = parseSearchIntent(query, action);
  const candidates = await searchPanelinhaCatalog(query, intent);
  const checked = await Promise.all(
    candidates.slice(0, 8).map((candidate) => withDeadline(enrichRecipe(candidate, env), 6500, null)),
  );
  const ranked = checked
    .filter((recipe) => recipe?.fonte?.status === "verified")
    .map((recipe) => {
      const relevance = scoreSearchRecipe(recipe, intent);
      return relevance === null ? null : { recipe, score: relevance + sourceRank(recipe) };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
  return selectDiverseRecipes(ranked.map(({ recipe }) => recipe), 4, 4);
}

async function searchPanelinhaCatalog(query, intent) {
  const preciseQuery = panelinhaSearchQuery(query, intent);
  if (!preciseQuery) return [];

  const response = await fetchWithTimeout(
    `https://${PANELINHA_SEARCH_HOST}/multi_search`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Typesense-Api-Key": PANELINHA_SEARCH_KEY,
      },
      body: JSON.stringify({
        searches: [{
          collection: "pan_pages",
          q: preciseQuery,
          query_by: "title,ingredients,description,categories,cuisines,extra",
          filter_by: "page_type:=Receitas",
          per_page: 12,
          page: 1,
        }],
      }),
    },
    6000,
  );
  if (!response.ok) throw new Error(`Busca Panelinha ${response.status}`);

  const payload = await response.json();
  const hits = Array.isArray(payload?.results?.[0]?.hits) ? payload.results[0].hits : [];
  return hits
    .map((hit) => panelinhaDocumentToCandidate(hit?.document, intent))
    .filter(Boolean);
}

function panelinhaSearchQuery(query, intent) {
  const filler = new Set([
    "a", "ao", "as", "com", "da", "das", "de", "do", "dos", "e", "em", "na", "nas", "no", "nos",
    "o", "os", "para", "por", "pra", "prato", "principal", "receita", "receitas", "somente", "so",
    "facil", "faceis", "rapida", "rapidas", "rapido", "rapidos", "pratica", "praticas", "pratico",
    "praticos", "jantar", "almoco", "quero", "queria", "busca", "buscar", "procuro", "procurar", "fazer",
    "uma", "um",
  ]);
  let words = normalize(query)
    .split(" ")
    .filter((word) => word.length > 1 && !filler.has(word));

  if (intent.protein === "carne_vermelha" && words.join(" ").includes("carne vermelha")) {
    words = words.join(" ").replace("carne vermelha", "carne bovina").split(" ");
  }
  if (!words.length && intent.course === "sobremesa") words = ["sobremesa"];
  return words.join(" ").slice(0, 180);
}

function panelinhaDocumentToCandidate(document, intent) {
  if (!document || typeof document !== "object") return null;
  const trackback = String(document.trackback || "");
  if (!trackback.startsWith("/receita/")) return null;

  const categories = Array.isArray(document.categories) ? document.categories.map(String) : [];
  const cuisines = Array.isArray(document.cuisines) ? document.cuisines.map(String) : [];
  const ingredientNames = Array.isArray(document.ingredients) ? document.ingredients.map(String) : [];
  const categoryText = normalize(categories.join(" "));
  const course = intent.course
    || (categoryText.includes("sobremesa") ? "sobremesa"
      : /(entrada|aperitivo|petisco)/.test(categoryText) ? "entrada"
        : "principal");
  const servings = Number(String(document.recipe_yield_text || "").match(/\d+/)?.[0] || 0);

  return {
    nome: cleanText(document.title || "").slice(0, 180),
    curso: course,
    tempo: cleanText(document.total_time_text || "").slice(0, 40),
    url: `https://panelinha.com.br${trackback}`,
    porque: cleanText(document.description || "Receita encontrada no catálogo do Panelinha.").slice(0, 360),
    tags: [...categories, ...cuisines, ...ingredientNames].slice(0, 24),
    rende_sobra: servings > 2,
    ingredientes: [],
    preparo: [],
  };
}

const SEARCH_STOP_WORDS = new Set([
  "a", "ao", "as", "com", "da", "das", "de", "do", "dos", "e", "em", "na", "nas", "no", "nos",
  "o", "os", "para", "por", "pra", "prato", "principal", "receita", "receitas", "somente", "so",
  "facil", "faceis", "rapida", "rapidas", "rapido", "rapidos", "pratica", "praticas", "pratico", "praticos",
  "air", "fryer", "airfryer", "fritadeira", "sobremesa", "sobremesas", "doce", "doces", "entrada", "entradas",
  "carne", "carnes", "vermelha", "vermelhas", "frango", "galinha", "peixe", "peixes", "porco", "suino",
]);

const PROTEIN_TERMS = {
  carne_vermelha: [
    "carne bovina", "carne vermelha", "carne seca", "carne-seca", "charque", "jaba",
    "bife", "patinho", "alcatra", "maminha", "picanha",
    "file mignon", "contrafile", "acem", "musculo", "lagarto", "coxao", "cupim", "bovino", "boi",
  ],
  frango: ["frango", "galinha", "sobrecoxa", "coxa de frango", "peito de frango"],
  peixe: ["peixe", "salmao", "tilapia", "bacalhau", "atum", "pescada", "sardinha"],
  porco: ["porco", "suino", "lombo", "bisteca", "pernil", "costelinha", "panceta"],
  vegetariano: ["vegetariano", "vegano", "sem carne"],
};

function parseSearchIntent(query, kind = "buscar") {
  const text = normalize(query);
  let course = "";
  if (/(sobremesa|doce|bolo|pudim|mousse|brigadeiro|cookie|torta doce|sorvete)/.test(text)) {
    course = "sobremesa";
  } else if (/(entrada|petisco|aperitivo|canape)/.test(text)) {
    course = "entrada";
  } else if (/(prato principal|almoco|jantar)/.test(text)) {
    course = "principal";
  }

  let protein = "";
  if (/(carne vermelha|carne bovina|carne seca|charque|jaba|bife|patinho|alcatra|maminha|picanha|file mignon|contrafile|acem|coxao|cupim)/.test(text)) {
    protein = "carne_vermelha";
  } else if (/(frango|galinha|sobrecoxa)/.test(text)) {
    protein = "frango";
  } else if (/(peixe|salmao|tilapia|bacalhau|atum|pescada|sardinha)/.test(text)) {
    protein = "peixe";
  } else if (/(porco|suino|lombo|bisteca|pernil|costelinha|panceta)/.test(text)) {
    protein = "porco";
  } else if (/(vegetariano|vegano|sem carne)/.test(text)) {
    protein = "vegetariano";
  }

  let method = "";
  if (/(air ?fryer|fritadeira sem oleo)/.test(text)) method = "airfryer";
  else if (/(panela de pressao)/.test(text)) method = "pressao";
  else if (/(forno|assad[oa])/.test(text)) method = "forno";
  else if (/(grelhad[oa])/.test(text)) method = "grelha";

  const tokens = text
    .split(" ")
    .filter((token) => token.length > 1 && !SEARCH_STOP_WORDS.has(token));
  return { text, kind, course, protein, method, tokens: [...new Set(tokens)] };
}

function searchConstraintPrompt(intent) {
  const lines = [];
  if (intent.course) lines.push(`- Curso obrigatório: ${intent.course}. Não misture outros tipos de prato.`);
  if (intent.protein) lines.push(`- Proteína obrigatória: ${intent.protein.replaceAll("_", " ")}.`);
  if (intent.method) lines.push(`- Método obrigatório: ${intent.method}.`);
  if (intent.tokens.length) lines.push(`- O nome ou os ingredientes precisam corresponder a: ${intent.tokens.join(", ")}.`);
  if (intent.kind === "com_ingredientes") lines.push("- Priorize o aproveitamento dos ingredientes informados.");
  return lines.length ? `Restrições obrigatórias:\n${lines.join("\n")}` : "Responda exatamente à intenção do pedido.";
}

function recipeSearchText(recipe) {
  return normalize([
    recipe.nome,
    recipe.curso,
    recipe.porque,
    ...(recipe.tags || []),
    ...(recipe.ingredientes || []),
    recipe.fonte?.title,
  ].join(" "));
}

function includesAny(text, terms = []) {
  return terms.some((term) => text.includes(term));
}

function recipeMatchesProtein(text, protein) {
  if (!protein) return true;
  if (protein === "carne_vermelha") {
    if (includesAny(text, PROTEIN_TERMS.carne_vermelha)) return true;
    const otherProtein = includesAny(text, [
      ...PROTEIN_TERMS.frango,
      ...PROTEIN_TERMS.peixe,
      ...PROTEIN_TERMS.porco,
    ]);
    return text.includes("carne") && !otherProtein;
  }
  return includesAny(text, PROTEIN_TERMS[protein] || []);
}

function recipeMatchesMethod(text, method) {
  if (!method) return true;
  const methods = {
    airfryer: ["airfryer", "air fryer", "fritadeira sem oleo"],
    pressao: ["panela de pressao", "pressao"],
    forno: ["forno", "assado", "assada"],
    grelha: ["grelha", "grelhado", "grelhada"],
  };
  return includesAny(text, methods[method] || []);
}

function scoreSearchRecipe(recipe, intent) {
  const text = recipeSearchText(recipe);
  if (intent.course && recipe.curso !== intent.course) return null;
  if (!recipeMatchesProtein(text, intent.protein)) return null;
  if (!recipeMatchesMethod(text, intent.method)) return null;

  const name = normalize(recipe.nome);
  const ingredients = normalize((recipe.ingredientes || []).join(" "));
  const tags = normalize((recipe.tags || []).join(" "));
  const hits = intent.tokens.filter((token) => text.includes(token));
  if (intent.tokens.length) {
    const required = intent.kind === "com_ingredientes"
      ? 1
      : Math.max(1, Math.ceil(intent.tokens.length * 0.5));
    if (hits.length < required) return null;
  }

  let score = hits.length * 5;
  score += intent.tokens.filter((token) => name.includes(token)).length * 9;
  score += intent.tokens.filter((token) => ingredients.includes(token)).length * (intent.kind === "com_ingredientes" ? 8 : 4);
  score += intent.tokens.filter((token) => tags.includes(token)).length * 4;
  if (intent.course) score += 18;
  if (intent.protein) score += 20;
  if (intent.method) score += 18;
  return score;
}

function selectDiverseRecipes(recipes, limit, maxPerDomain = 2) {
  const selected = [];
  const domainCounts = new Map();
  const names = new Set();
  for (const recipe of recipes) {
    const name = normalize(recipe.nome);
    const domain = recipe.fonte?.domain || "";
    if (names.has(name) || (domainCounts.get(domain) || 0) >= maxPerDomain) continue;
    selected.push(recipe);
    names.add(name);
    domainCounts.set(domain, (domainCounts.get(domain) || 0) + 1);
    if (selected.length >= limit) break;
  }
  return selected;
}

function trustedFallbackCandidates(intent) {
  if (intent.protein === "frango" && intent.method === "airfryer") {
    return [
      {
        nome: "Frango Suculento na Air Fryer",
        curso: "principal",
        tempo: "aprox. 30 minutos",
        url: "https://www.receitasnestle.com.br/receitas/receita-frango-suculento-air-fryer",
        porque: "Frango preparado diretamente na air fryer, com fonte testada.",
        tags: ["frango", "airfryer", "pratico"],
        rende_sobra: true,
        ingredientes: [],
        preparo: [],
      },
      {
        nome: "Frango Crocante na Air Fryer",
        curso: "principal",
        tempo: "aprox. 30 minutos",
        url: "https://www.receitasnestle.com.br/receitas/receita-frango-crocante-na-air-fryer",
        porque: "Peito de frango crocante feito na air fryer.",
        tags: ["frango", "airfryer", "crocante"],
        rende_sobra: true,
        ingredientes: [],
        preparo: [],
      },
    ];
  }
  if (intent.protein === "carne_vermelha") {
    return [{
      nome: "Bife Simples e Rápido",
      curso: "principal",
      tempo: "15 minutos",
      url: "https://www.tudogostoso.com.br/receita/122640-bife-simples-e-rapido.html",
      porque: "Bife bovino rápido para uma refeição do dia a dia.",
      tags: ["carne_vermelha", "bife", "rapido"],
      rende_sobra: true,
      ingredientes: [],
      preparo: [],
    }];
  }
  if (intent.course === "sobremesa") {
    return [{
      nome: "Brigadeirão de Micro-ondas",
      curso: "sobremesa",
      tempo: "10 minutos (+ geladeira)",
      url: "https://www.receitasnestle.com.br/receitas/brigadeirao-de-micro-ondas",
      porque: "Sobremesa de chocolate fácil, rápida e com fonte testada.",
      tags: ["sobremesa", "chocolate", "rapido"],
      rende_sobra: true,
      ingredientes: [],
      preparo: [],
    }];
  }
  return [];
}

function queryUrlCandidates(query, intent) {
  const phrase = normalize(query)
    .replace(/\b(eu|quero|queria|busca|buscar|procuro|procurar|fazer|uma|um|receita|receitas)\b/g, " ")
    .replace(/\b(prato principal|para o jantar|para jantar|para o almoco|para almoco)\b/g, " ")
    .replace(/\b(facil|faceis|rapida|rapidas|rapido|rapidos|pratica|praticas|pratico|praticos)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!phrase || phrase.length < 3) return [];

  const slug = phrase.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!slug) return [];
  const name = phrase.replace(/\b\w/g, (letter) => letter.toUpperCase());
  const base = {
    nome: name,
    curso: intent.course || "principal",
    tempo: "",
    porque: "Correspondência direta com o prato digitado.",
    tags: [...intent.tokens, intent.method, intent.protein].filter(Boolean),
    rende_sobra: false,
    ingredientes: [],
    preparo: [],
  };
  return [
    { ...base, url: `https://www.receitasnestle.com.br/receitas/${slug}` },
    { ...base, url: `https://www.receitasnestle.com.br/receitas/receita-${slug}` },
    { ...base, url: `https://panelinha.com.br/receita/${slug}` },
  ];
}

async function readSearchJob(jobId) {
  if (!jobId) return { status: "missing", pratos: [] };
  const response = await caches.default.match(searchCacheRequest(jobId));
  if (!response) return { status: "missing", pratos: [] };
  try {
    return await response.json();
  } catch {
    return { status: "missing", pratos: [] };
  }
}

async function writeSearchJob(jobId, payload, ttl) {
  const response = new Response(JSON.stringify(payload), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `public, max-age=${ttl}`,
    },
  });
  await caches.default.put(searchCacheRequest(jobId), response);
}

function searchCacheRequest(jobId) {
  return new Request(`https://cozinha-cache.invalid/search/${encodeURIComponent(jobId)}`);
}

async function handleImage(body, env) {
  const name = String(body.consulta || body.nome || "").trim().slice(0, 160);
  const pageUrl = String(body.url || "").trim();
  let source = null;
  if (name && pageUrl) {
    const verified = await verifyRecipePage(name, pageUrl, env);
    if (verified?.image) {
      source = {
        url: verified.image,
        kind: "source",
        alt: name,
        source_url: verified.url,
      };
    }
  }
  if (source) return { imagem: source };
  const bank = await pexelsImage(name, body.excluir_ids || [], env);
  return { imagem: bank || { kind: "none", url: "", alt: name } };
}

async function handlePhoto(body, env) {
  requireSecret(env, "GEMINI_API_KEY");
  if (!body.imagem || String(body.imagem).length > 10_500_000) throw new Error("imagem ausente ou grande demais");
  const prompt = [
    "Leia esta imagem como uma receita ou lista de ingredientes.",
    "Retorne somente um array JSON de strings.",
    "Mantenha as quantidades visíveis. Não invente itens ilegíveis.",
    'Exemplo: ["2 cebolas", "500 g de carne"].',
  ].join(" ");
  const result = await geminiJson(env, prompt, false, [{
    inline_data: {
      mime_type: safeMime(body.mime),
      data: body.imagem,
    },
  }]);
  return { ingredientes: Array.isArray(result) ? result.slice(0, 100).map(String) : [] };
}

async function handleRecipePhoto(body, env, workerOrigin) {
  requireSecret(env, "GEMINI_API_KEY");
  if (!env.DB) throw new Error("binding D1 DB ausente");
  if (!env.PHOTOS) throw new Error("binding R2 PHOTOS ausente");
  if (!body.imagem || String(body.imagem).length > 10_500_000) {
    throw new Error("imagem ausente ou grande demais");
  }
  await ensureDatabase(env);

  const mime = safeMime(body.mime);
  const visionPrompt = `
Analise esta foto enviada por um casal para seu caderno privado de receitas.
Ela pode mostrar um prato pronto, uma página de livro, uma receita manuscrita ou uma captura de tela.
Identifique o nome mais provável do prato. Quando houver texto legível, extraia ingredientes e preparo
sem inventar o que não está visível. Quando for apenas a foto do prato, deixe ingredientes e preparo vazios,
pois outra etapa encontrará uma receita confiável.
Retorne somente:
{
  "nome": string,
  "curso": "principal" | "entrada" | "sobremesa",
  "tempo": string,
  "porque": string,
  "tags": string[],
  "rende_sobra": boolean,
  "ingredientes": string[],
  "preparo": string[]
}
`.trim();
  const identified = await geminiJson(env, visionPrompt, false, [{
    inline_data: {
      mime_type: mime,
      data: body.imagem,
    },
  }]);
  const cleanIdentified = sanitizeRecipe(identified);
  if (!cleanIdentified.nome) throw new Error("não foi possível identificar o prato");

  let matched = null;
  try {
    const candidates = await runVerifiedSearch("buscar", cleanIdentified.nome, env);
    matched = candidates.find((recipe) => recipe.fonte?.status === "verified") || candidates[0] || null;
  } catch {
    matched = null;
  }
  const recipe = sanitizeRecipe({
    ...(matched || cleanIdentified),
    porque: matched?.porque || cleanIdentified.porque || "Prato registrado por foto.",
    tags: [...new Set([...(matched?.tags || []), ...(cleanIdentified.tags || []), "foto_do_casal"])],
    ingredientes: matched?.ingredientes?.length ? matched.ingredientes : cleanIdentified.ingredientes,
    preparo: matched?.preparo?.length ? matched.preparo : cleanIdentified.preparo,
  });
  recipe.id ||= stableRecipeId(recipe);

  const key = `favorite-${Date.now()}-${crypto.randomUUID()}.${extensionForMime(mime)}`;
  await env.PHOTOS.put(key, base64ToBytes(body.imagem), {
    httpMetadata: { contentType: mime },
    customMetadata: {
      recipeId: recipe.id,
      recipeName: recipe.nome.slice(0, 120),
    },
  });

  const mediaUrl = `${workerOrigin}/media/${encodeURIComponent(key)}`;
  recipe.imagem = {
    kind: "user",
    url: mediaUrl,
    alt: `Foto enviada de ${recipe.nome}`,
    credit: "Ana & Rafael",
  };
  const eventId = String(body.event_id || crypto.randomUUID()).slice(0, 180);
  try {
    await saveFavorite(env, recipe, "photo", key);
    await env.DB.prepare(`
      INSERT OR IGNORE INTO taste_events (event_id, recipe_id, vote)
      VALUES (?, ?, 'like')
    `).bind(eventId, recipe.id).run();
  } catch (error) {
    await env.PHOTOS.delete(key);
    throw error;
  }
  const githubSynced = await dispatchTasteToGitHub({
    voto: "like",
    eventId,
    recipe,
  }, env);
  return {
    ok: true,
    receita: recipe,
    banco: true,
    foto_armazenada: true,
    perfil_github: githubSynced,
  };
}

async function handleSaveShopping(body, env) {
  if (!await ensureDatabase(env)) {
    return { ok: true, storage: "local" };
  }
  const state = body.shopping && typeof body.shopping === "object" ? body.shopping : {};
  const serialized = JSON.stringify(state);
  if (serialized.length > 120_000) throw new Error("lista grande demais");
  await env.DB.prepare(`
    INSERT INTO app_state (state_key, state_json, updated_at)
    VALUES ('shopping', ?, CURRENT_TIMESTAMP)
    ON CONFLICT(state_key) DO UPDATE SET
      state_json = excluded.state_json,
      updated_at = CURRENT_TIMESTAMP
  `).bind(serialized).run();
  return { ok: true, storage: "d1" };
}

async function handleConsolidate(body, env) {
  requireSecret(env, "GEMINI_API_KEY");
  const ingredients = Array.isArray(body.ingredientes)
    ? body.ingredientes.map(String).filter(Boolean).slice(0, 500)
    : [];
  if (!ingredients.length) return { lista: {} };
  const prompt = `
Consolide estes ingredientes numa lista de compras em português do Brasil.
- Agrupe nomes equivalentes e some apenas quantidades com unidades compatíveis.
- Para itens contáveis, arredonde a soma para cima.
- Não some "a gosto" com números.
- Categorias permitidas: Proteínas; Hortifruti; Laticínios e ovos; Mercearia; Padaria; Outros.
- Retorne apenas um objeto JSON: { "Categoria": ["quantidade item"] }.

INGREDIENTES:
${ingredients.map((item) => `- ${item}`).join("\n")}
`.trim();
  const result = await geminiJson(env, prompt, false);
  return { lista: result && typeof result === "object" && !Array.isArray(result) ? result : {} };
}

async function handleSides(body, env) {
  requireSecret(env, "GEMINI_API_KEY");
  const dish = String(body.prato || "").trim().slice(0, 180);
  if (!dish) return { acompanhamentos: [] };
  const prompt = `
Para "${dish}", sugira de 2 a 4 acompanhamentos simples que equilibrem o jantar.
${PROFILE}
Retorne apenas um array JSON de objetos { "nome": string, "dica": string }.
`.trim();
  const result = await geminiJson(env, prompt, false);
  return { acompanhamentos: Array.isArray(result) ? result.slice(0, 4) : [] };
}

async function geminiJson(env, prompt, useSearch, extraParts = [], fast = false) {
  requireSecret(env, "GEMINI_API_KEY");
  const model = String(
    fast
      ? env.GEMINI_SEARCH_MODEL || DEFAULT_SEARCH_MODEL
      : env.GEMINI_MODEL || DEFAULT_MODEL,
  );
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`;
  const body = {
    contents: [{ parts: [{ text: prompt }, ...extraParts] }],
    generationConfig: {
      temperature: useSearch ? 0.25 : 0.15,
    },
  };
  if (!useSearch) body.generationConfig.responseMimeType = "application/json";
  if (fast) {
    body.generationConfig.maxOutputTokens = 4096;
    if (model.startsWith("gemini-2.5")) {
      body.generationConfig.thinkingConfig = { thinkingBudget: 0 };
    }
  }
  if (useSearch) body.tools = [{ google_search: {} }];

  const geminiTimeout = useSearch ? 22_000 : 20_000;
  let response = await fetchGeminiWithRetry(endpoint, body, geminiTimeout, useSearch ? 2 : 1);
  if (!response.ok && response.status === 400 && body.generationConfig?.responseMimeType) {
    const fallbackBody = structuredClone(body);
    delete fallbackBody.generationConfig.responseMimeType;
    response = await fetchGeminiWithRetry(endpoint, fallbackBody, geminiTimeout, useSearch ? 2 : 1);
  }
  if (!response.ok) throw new Error(`Gemini ${response.status}`);
  const payload = await response.json();
  const text = (payload?.candidates?.[0]?.content?.parts || [])
    .map((part) => part.text)
    .filter(Boolean)
    .join("");
  const grounded = useSearch
    ? (payload?.candidates?.[0]?.groundingMetadata?.groundingChunks || [])
        .map((chunk) => chunk?.web)
        .filter((web) => web?.uri && web?.title)
        .slice(0, 5)
    : [];
  const groundedRecipes = grounded.map((web) => ({
    nome: cleanText(web.title).slice(0, 180),
    curso: "principal",
    tempo: "",
    url: web.uri,
    porque: "Resultado localizado em uma fonte permitida.",
    tags: [],
    rende_sobra: false,
    ingredientes: [],
    preparo: [],
  }));

  try {
    const parsed = parseJson(text);
    if (!groundedRecipes.length) return parsed;
    return { pratos: [...asRecipeArray(parsed), ...groundedRecipes] };
  } catch (error) {
    if (groundedRecipes.length) return { pratos: groundedRecipes };
    throw error;
  }
}

async function fetchGeminiWithRetry(endpoint, body, timeoutMs, attempts) {
  let response;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      response = await fetchWithTimeout(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }, timeoutMs);
      if (response.ok || (response.status !== 429 && response.status < 500)) return response;
    } catch (error) {
      lastError = error;
    }
    if (attempt + 1 < attempts) await wait(900 * (attempt + 1));
  }
  if (response) return response;
  throw lastError || new Error("Gemini indisponível");
}

async function enrichRecipe(raw, env) {
  const recipe = sanitizeRecipe(raw);
  if (!recipe.nome) return null;
  const verified = await verifyRecipePage(recipe.nome, raw.url, env);
  if (verified) {
    recipe.fonte = {
      status: "verified",
      url: verified.url,
      title: verified.title,
      domain: verified.domain,
      checked_at: new Date().toISOString(),
      confidence: verified.confidence,
      rating: verified.rating,
      rating_count: verified.ratingCount,
    };
    recipe.imagem = verified.image
      ? { kind: "source", url: verified.image, alt: recipe.nome }
      : { kind: "none", url: "", alt: recipe.nome };
    recipe.tempo ||= verified.totalTime || "";
    recipe.ingredientes = recipe.ingredientes.length ? recipe.ingredientes : verified.ingredients;
    recipe.preparo = recipe.preparo.length ? recipe.preparo : verified.instructions;
  } else {
    recipe.fonte = {
      status: "unverified",
      url: "",
      suggested_url: safePublicUrl(raw.url, env) || "",
      checked_at: new Date().toISOString(),
    };
    const bank = await pexelsImage(recipe.nome, [], env);
    recipe.imagem = bank || { kind: "none", url: "", alt: recipe.nome };
  }
  recipe.id = stableRecipeId(recipe);
  return recipe;
}

async function verifyRecipePage(name, rawUrl, env) {
  const url = safeRecipeCandidateUrl(rawUrl, env);
  if (!url) return null;

  let response;
  try {
    response = await fetchWithTimeout(url, {
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; CozinhaRecipeVerifier/3.0)",
        "Accept": "text/html,application/xhtml+xml",
      },
    }, 5500);
  } catch {
    return null;
  }

  if (!response.ok) return null;
  const type = response.headers.get("content-type") || "";
  if (!type.includes("text/html")) return null;
  const length = Number(response.headers.get("content-length") || 0);
  if (length > 2_000_000) return null;
  const html = (await response.text()).slice(0, 2_000_000);
  const recipeSchema = extractRecipeSchema(html);
  const title = decodeHtml(
    recipeSchema?.name
      || metaContent(html, "og:title")
      || firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i)
      || "",
  );
  const similarity = titleSimilarity(name, title);
  const hasRecipeEvidence = Boolean(
    recipeSchema
    || /itemtype=["'][^"']*schema\.org\/Recipe/i.test(html)
    || /ingredientes|modo de preparo|ingredients|instructions/i.test(html),
  );
  if (similarity < 0.42 || !hasRecipeEvidence) return null;

  const finalUrl = response.url || url;
  const canonicalRaw = firstMatch(html, /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)
    || firstMatch(html, /<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i);
  const canonical = resolveUrl(canonicalRaw, finalUrl) || finalUrl;
  if (!safePublicUrl(canonical, env)) return null;

  const schemaImageValue = Array.isArray(recipeSchema?.image)
    ? recipeSchema.image[0]
    : recipeSchema?.image;
  const schemaImage = typeof schemaImageValue === "object"
    ? schemaImageValue.url || schemaImageValue.contentUrl
    : schemaImageValue;
  const imageRaw = schemaImage || metaContent(html, "og:image") || metaContent(html, "twitter:image");
  const image = safeImageUrl(resolveUrl(imageRaw, finalUrl));
  const rating = Number(recipeSchema?.aggregateRating?.ratingValue || 0);
  const ratingCount = Number(
    recipeSchema?.aggregateRating?.ratingCount
    || recipeSchema?.aggregateRating?.reviewCount
    || 0,
  );

  return {
    url: canonical,
    title: cleanText(title).slice(0, 220),
    domain: new URL(canonical).hostname.replace(/^www\./, ""),
    confidence: Number(similarity.toFixed(2)),
    rating: Number.isFinite(rating) ? rating : 0,
    ratingCount: Number.isFinite(ratingCount) ? ratingCount : 0,
    image,
    totalTime: String(recipeSchema?.totalTime || ""),
    ingredients: Array.isArray(recipeSchema?.recipeIngredient) ? recipeSchema.recipeIngredient.map(String).slice(0, 60) : [],
    instructions: schemaInstructions(recipeSchema?.recipeInstructions),
  };
}

function safeRecipeCandidateUrl(raw, env) {
  const direct = safePublicUrl(raw, env);
  if (direct) return direct;

  try {
    const url = new URL(raw);
    const isGroundingRedirect =
      url.protocol === "https:" &&
      url.hostname === "vertexaisearch.cloud.google.com" &&
      url.pathname.startsWith("/grounding-api-redirect/");

    return isGroundingRedirect ? url.toString() : null;
  } catch {
    return null;
  }
}

function extractRecipeSchema(html) {
  const blocks = [...html.matchAll(
    /<script[^>]+type=(?:["']application\/ld\+json["']|application\/ld\+json)[^>]*>([\s\S]*?)<\/script>/gi,
  )];
  for (const match of blocks.slice(0, 20)) {
    try {
      const data = JSON.parse(decodeHtml(match[1].trim()));
      const recipes = flattenLd(data).filter((item) => {
        const types = Array.isArray(item?.["@type"]) ? item["@type"] : [item?.["@type"]];
        return types.some((type) => String(type).toLowerCase() === "recipe");
      });
      if (recipes[0]) return recipes[0];
    } catch {
      // Páginas com JSON-LD inválido ainda podem ser validadas pelos metadados.
    }
  }
  return null;
}

function flattenLd(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(flattenLd);
  if (typeof value !== "object") return [];
  return [value, ...flattenLd(value["@graph"] || [])];
}

function schemaInstructions(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((step) => {
    if (typeof step === "string") return [cleanText(step)];
    if (step?.itemListElement) {
      return schemaInstructions(Array.isArray(step.itemListElement)
        ? step.itemListElement
        : [step.itemListElement]);
    }
    return step?.text ? [cleanText(step.text)] : [];
  }).filter(Boolean).slice(0, 20);
}

async function pexelsImage(query, excludedIds, env) {
  if (!env.PEXELS_KEY || !query || String(env.ENABLE_PEXELS_FALLBACK || "false").toLowerCase() !== "true") return null;
  const excluded = new Set((excludedIds || []).map(String));
  const endpoint = `https://api.pexels.com/v1/search?per_page=12&orientation=landscape&locale=pt-BR&query=${encodeURIComponent(`${query} comida prato`)}`;
  try {
    const response = await fetchWithTimeout(endpoint, {
      headers: { "Authorization": env.PEXELS_KEY },
    }, 4500);
    if (!response.ok) return null;
    const payload = await response.json();
    const terms = usefulTokens(query);
    const scored = (payload.photos || [])
      .filter((photo) => !excluded.has(String(photo.id)))
      .map((photo) => {
        const alt = normalize(photo.alt || "");
        const score = terms.filter((term) => alt.includes(term)).length;
        return { photo, score };
      })
      .sort((a, b) => b.score - a.score);
    const best = scored.find(({ score }) => score > 0)?.photo;
    if (!best) return null;
    return {
      kind: "bank",
      url: best.src?.large || best.src?.medium || "",
      alt: best.alt || query,
      bank_id: String(best.id),
      credit: best.photographer || "Pexels",
    };
  } catch {
    return null;
  }
}

function sanitizeRecipe(raw) {
  const recipe = raw && typeof raw === "object" ? raw : {};
  return {
    id: String(recipe.id || "").slice(0, 120),
    nome: cleanText(recipe.nome || recipe.titulo || "").slice(0, 180),
    curso: ["principal", "entrada", "sobremesa"].includes(String(recipe.curso).toLowerCase())
      ? String(recipe.curso).toLowerCase()
      : "principal",
    tempo: cleanText(recipe.tempo || "").slice(0, 40),
    porque: cleanText(recipe.porque || "").slice(0, 400),
    tags: Array.isArray(recipe.tags) ? recipe.tags.map((tag) => normalize(tag).replace(/\s+/g, "_")).filter(Boolean).slice(0, 8) : [],
    rende_sobra: Boolean(recipe.rende_sobra),
    ingredientes: Array.isArray(recipe.ingredientes) ? recipe.ingredientes.map((item) => cleanText(item).slice(0, 240)).filter(Boolean).slice(0, 80) : [],
    preparo: Array.isArray(recipe.preparo) ? recipe.preparo.map((step) => cleanText(step).slice(0, 600)).filter(Boolean).slice(0, 20) : [],
    fonte: recipe.fonte && typeof recipe.fonte === "object"
      ? {
          status: recipe.fonte.status === "verified" ? "verified" : "unverified",
          url: safeLooseHttpUrl(recipe.fonte.url),
          title: cleanText(recipe.fonte.title || "").slice(0, 220),
          domain: cleanText(recipe.fonte.domain || "").slice(0, 120),
          checked_at: cleanText(recipe.fonte.checked_at || "").slice(0, 80),
          confidence: Number(recipe.fonte.confidence || 0),
          rating: Number(recipe.fonte.rating || 0),
          rating_count: Number(recipe.fonte.rating_count || 0),
        }
      : undefined,
    imagem: recipe.imagem && typeof recipe.imagem === "object"
      ? {
          kind: ["source", "bank", "user"].includes(recipe.imagem.kind) ? recipe.imagem.kind : "none",
          url: safeLooseHttpUrl(recipe.imagem.url),
          alt: cleanText(recipe.imagem.alt || "").slice(0, 220),
          credit: cleanText(recipe.imagem.credit || "").slice(0, 160),
          bank_id: cleanText(recipe.imagem.bank_id || "").slice(0, 80),
        }
      : undefined,
  };
}

function safeLooseHttpUrl(raw) {
  try {
    const url = new URL(String(raw || ""));
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return "";
    return url.toString();
  } catch {
    return "";
  }
}

function asRecipeArray(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.pratos)) return value.pratos;
  if (Array.isArray(value?.recipes)) return value.recipes;
  return [];
}

function safePublicUrl(raw, env) {
  try {
    const url = new URL(String(raw || ""));
    if (!["http:", "https:"].includes(url.protocol)) return null;
    if (url.username || url.password || url.port) return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (!allowedRecipeHosts(env).some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function safeImageUrl(raw) {
  try {
    const url = new URL(String(raw || ""));
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function allowedRecipeHosts(env) {
  const configured = String(env.ALLOWED_RECIPE_HOSTS || "")
    .split(",")
    .map((host) => host.trim().toLowerCase().replace(/^www\./, ""))
    .filter(Boolean);
  return configured.length ? configured : DEFAULT_RECIPE_HOSTS;
}

function sourcePriorityPrompt(env) {
  const allowed = new Set(allowedRecipeHosts(env));
  const lines = [];
  for (const [tier, hosts] of Object.entries(SOURCE_TIERS).sort((a, b) => Number(b[0]) - Number(a[0]))) {
    const available = hosts.filter((host) => allowed.has(host));
    if (available.length) {
      const label = Number(tier) === 3 ? "Prioridade máxima" : Number(tier) === 2 ? "Boas fontes práticas" : "Fontes complementares";
      lines.push(`- ${label}: ${available.join(", ")}`);
    }
  }
  const listed = new Set(Object.values(SOURCE_TIERS).flat());
  const extra = [...allowed].filter((host) => !listed.has(host));
  if (extra.length) lines.push(`- Outras fontes permitidas: ${extra.join(", ")}`);
  return lines.join("\n");
}

function sourceTier(domain) {
  const host = String(domain || "").toLowerCase().replace(/^www\./, "");
  for (const [tier, hosts] of Object.entries(SOURCE_TIERS)) {
    if (hosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) {
      return Number(tier);
    }
  }
  return 0;
}

function titleSimilarity(name, title) {
  const a = usefulTokens(name);
  const b = new Set(usefulTokens(title));
  if (!a.length || !b.size) return 0;
  const matches = a.filter((token) => b.has(token)).length;
  const coverage = matches / a.length;
  const minimumMatchBonus = matches >= Math.min(2, a.length) ? 0.16 : 0;
  return Math.min(1, coverage * 0.84 + minimumMatchBonus);
}

function usefulTokens(value) {
  const stop = new Set([
    "receita", "facil", "rapida", "rapido", "caseiro", "caseira", "como",
    "fazer", "para", "com", "uma", "por", "dos", "das", "de", "da", "do", "e",
  ]);
  return normalize(value).split(" ").filter((token) => token.length > 2 && !stop.has(token));
}

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanText(value) {
  return decodeHtml(String(value || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim());
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function metaContent(html, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return firstMatch(html, new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["']`, "i"))
    || firstMatch(html, new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["']`, "i"));
}

function firstMatch(text, regex) {
  return text.match(regex)?.[1]?.trim() || "";
}

function resolveUrl(raw, base) {
  try {
    return raw ? new URL(raw, base).toString() : "";
  } catch {
    return "";
  }
}

function sourceRank(recipe) {
  const verified = recipe.fonte?.status === "verified" ? 10 : 0;
  const sourceImage = recipe.imagem?.kind === "source" ? 3 : 0;
  const trust = sourceTier(recipe.fonte?.domain) * 2;
  const rating = Math.min(2, Number(recipe.fonte?.rating || 0) / 2.5);
  const popularity = Math.min(1.5, Math.log10(1 + Number(recipe.fonte?.rating_count || 0)) / 2);
  return verified + sourceImage + trust + rating + popularity + Number(recipe.fonte?.confidence || 0);
}

function stableRecipeId(recipe) {
  const raw = `${normalize(recipe.nome)}|${recipe.fonte?.url || ""}`;
  let hash = 2166136261;
  for (const char of raw) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `${normalize(recipe.nome).replace(/\s+/g, "-").slice(0, 50)}-${(hash >>> 0).toString(36)}`;
}

function safeMime(value) {
  const allowed = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);
  return allowed.has(String(value).toLowerCase()) ? String(value).toLowerCase() : "image/jpeg";
}

function extensionForMime(mime) {
  return {
    "image/png": "png",
    "image/webp": "webp",
    "image/heic": "heic",
    "image/heif": "heif",
  }[mime] || "jpg";
}

function base64ToBytes(value) {
  const binary = atob(String(value || ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function parseJson(text) {
  const value = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(value);
  } catch {
    const objectStart = value.indexOf("{");
    const objectEnd = value.lastIndexOf("}");
    const arrayStart = value.indexOf("[");
    const arrayEnd = value.lastIndexOf("]");
    if (arrayStart >= 0 && (objectStart < 0 || arrayStart < objectStart)) {
      return JSON.parse(value.slice(arrayStart, arrayEnd + 1));
    }
    if (objectStart >= 0) return JSON.parse(value.slice(objectStart, objectEnd + 1));
    throw new Error("Resposta do modelo não era JSON");
  }
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withDeadline(promise, timeoutMs, fallback) {
  let timeout;
  try {
    return await Promise.race([
      Promise.resolve(promise).catch(() => fallback),
      new Promise((resolve) => {
        timeout = setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function hashText(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

function safeError(error) {
  const message = String(error?.message || error || "erro").replace(/[<>{}]/g, "");
  return message.slice(0, 180);
}
