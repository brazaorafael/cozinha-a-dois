#!/usr/bin/env python3
"""Gera o cardápio do Cozinha, valida fontes e envia o e-mail.

Modos:
  AGENT_MODE=diario
  AGENT_MODE=semanal
"""

from __future__ import annotations

import datetime as dt
import html
import json
import os
import smtplib
import ssl
import sys
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formataddr
from pathlib import Path
from typing import Any

from google import genai
from google.genai import types

from recipe_verifier import enrich_recipe

DATA_DIR = Path("data")
RECIPES_FILE = DATA_DIR / "receitas.json"
HISTORY_FILE = DATA_DIR / "historico.json"
PROFILE_FILE = DATA_DIR / "perfil_gostos.json"

MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
MODE = os.environ.get("AGENT_MODE", "diario").strip().lower()
APP_URL = os.environ.get("APP_URL", "").strip()
GEMINI_API_KEY = os.environ["GEMINI_API_KEY"]
GMAIL_ADDRESS = os.environ["GMAIL_ADDRESS"]
GMAIL_APP_PASSWORD = os.environ["GMAIL_APP_PASSWORD"]
RECIPIENTS = [
    email.strip()
    for email in os.environ.get("MAIL_TO", GMAIL_ADDRESS).replace(";", ",").split(",")
    if email.strip()
]

NOW = dt.datetime.now(dt.timezone(dt.timedelta(hours=-3)))
DATE_BR = NOW.strftime("%d/%m/%Y")
WEEK_DAYS = ["segunda", "terça", "quarta", "quinta", "sexta", "sábado", "domingo"]
DAY_NAME = WEEK_DAYS[NOW.weekday()]
NEXT_MONDAY = NOW + dt.timedelta(days=7 - NOW.weekday())
NEXT_SUNDAY = NEXT_MONDAY + dt.timedelta(days=6)
WEEK_PERIOD = f"{NEXT_MONDAY:%d/%m} a {NEXT_SUNDAY:%d/%m/%Y}"

PROFILE = """
PERFIL:
- Casal jovem; jantar para 2. Quando fizer sentido, sobra para o almoço de 1 pessoa.
- Prioridade em proteína e equilíbrio entre proteína, carboidrato e vegetais.
- Maioria das receitas fácil, prática e pronta em até cerca de 45 minutos.
- Pouca fritura: priorize airfryer, forno, grelha e refogado.
- Carne vermelha é a preferida. Peixe no máximo uma vez por semana.
- Ingredientes acessíveis em supermercados brasileiros.
""".strip()

SOURCES = """
FONTES PERMITIDAS, EM ORDEM DE CONFIANÇA:
Prioridade máxima — receitas mais testadas:
- panelinha.com.br
- receitasnestle.com.br
- receitas.globo.com
- anamariabraga.globo.com
- tudogostoso.com.br (prefira as mais bem avaliadas)

Boas fontes para receitas práticas:
- guiadacozinha.com.br
- cookpad.com/br (prefira as mais bem avaliadas)
- tudoreceitas.com
- cybercook.com.br
- tastemade.com.br

Fontes complementares e especializadas:
- naminhapanela.com
- receitasdeminuto.com
- presuntovegetariano.com.br
- daninoce.com.br
- amopaocaseiro.com.br
- pitadinha.com
- pratofundo.com
- cozinhalegal.com.br

As URLs precisam ser páginas diretas de receitas reais. Nunca invente URL.
Em caso de empate, escolha a fonte do grupo mais confiável e a receita com melhor avaliação.
""".strip()

RECIPE_SCHEMA = """
Cada prato deve ter:
{
  "nome": string,
  "curso": "principal" | "entrada" | "sobremesa",
  "tempo": string,
  "url": string,
  "porque": string,
  "tags": string[],
  "rende_sobra": boolean,
  "ingredientes": string[],
  "preparo": string[]
}
Use 2 a 4 tags padronizadas. Ingredientes devem trazer quantidades quando possível.
O preparo deve ter de 4 a 7 passos curtos, claros e escritos com palavras próprias.
""".strip()
COURSE_COUNTS = {"principal": 2, "entrada": 1, "sobremesa": 1}


def load_json(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return fallback


def save_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def preferences_context() -> str:
    profile = load_json(PROFILE_FILE, {})
    history = load_json(HISTORY_FILE, [])
    rejected = [item.get("titulo", "") for item in profile.get("rejeitadas", []) if item.get("titulo")]
    recent = [item.get("titulo", "") for item in history[-80:] if item.get("titulo")]
    parts = []
    if profile.get("resumo"):
        parts.append("Preferências aprendidas: " + profile["resumo"])
    if rejected:
        parts.append("Não sugerir pratos rejeitados: " + "; ".join(rejected[-50:]))
    if recent:
        parts.append("Evitar repetir pratos recentes: " + "; ".join(recent))
    return "\n".join(parts) or "Ainda não há preferências registradas."


def call_gemini(prompt: str, temperature: float = 0.35) -> Any:
    client = genai.Client(api_key=GEMINI_API_KEY)
    json_config = types.GenerateContentConfig(
        tools=[types.Tool(google_search=types.GoogleSearch())],
        temperature=temperature,
        response_mime_type="application/json",
    )
    try:
        response = client.models.generate_content(model=MODEL, contents=prompt, config=json_config)
    except Exception:  # Alguns modelos combinam grounding e JSON apenas no modo textual.
        fallback_config = types.GenerateContentConfig(
            tools=[types.Tool(google_search=types.GoogleSearch())],
            temperature=temperature,
        )
        response = client.models.generate_content(model=MODEL, contents=prompt, config=fallback_config)
    return parse_json(response.text or "")


def parse_json(text: str) -> Any:
    value = text.strip()
    if value.startswith("```"):
        value = value.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        object_start, object_end = value.find("{"), value.rfind("}")
        array_start, array_end = value.find("["), value.rfind("]")
        if array_start >= 0 and (object_start < 0 or array_start < object_start):
            return json.loads(value[array_start:array_end + 1])
        return json.loads(value[object_start:object_end + 1])


def candidate_prompt() -> str:
    scope = (
        "para hoje: 8 a 10 candidatos variados"
        if MODE == "diario"
        else "para os sete dias da próxima semana: candidatos variados suficientes para evitar repetição"
    )
    return f"""
Você é um pesquisador de receitas. Pesquise agora ideias {scope}.
{PROFILE}
{SOURCES}
{preferences_context()}
Retorne somente JSON: uma lista de objetos com nome, curso, motivo, ingredientes principais e url.
""".strip()


def curator_prompt(candidates: Any) -> str:
    candidates_json = json.dumps(candidates, ensure_ascii=False)
    if MODE == "semanal":
        output = f"""
{{
  "tipo": "semanal",
  "periodo": "{WEEK_PERIOD}",
  "dias": [
    {{ "dia": "Segunda", "pratos": [] }},
    {{ "dia": "Terça", "pratos": [] }},
    {{ "dia": "Quarta", "pratos": [] }},
    {{ "dia": "Quinta", "pratos": [] }},
    {{ "dia": "Sexta", "pratos": [] }},
    {{ "dia": "Sábado", "pratos": [] }},
    {{ "dia": "Domingo", "pratos": [] }}
  ]
}}
Para cada dia: 2 principais, 1 entrada e 1 sobremesa. Na semana toda, no máximo 1 peixe.
"""
    else:
        output = f"""
{{
  "tipo": "diario",
  "data": "{DATE_BR}",
  "dia_semana": "{DAY_NAME}",
  "pratos": []
}}
Inclua 2 principais, 1 entrada e 1 sobremesa.
"""
    return f"""
Você é o curador final do cardápio do casal.
{PROFILE}
{SOURCES}
{preferences_context()}
Escolha pratos práticos, variados e coerentes. Não invente URLs.
{RECIPE_SCHEMA}
CANDIDATOS:
{candidates_json}
Retorne somente JSON neste formato:
{output}
""".strip()


def select_menu_recipes(raw_recipes: Any, context: str) -> list[dict[str, Any]]:
    """Impede que o modelo devolva mais ou menos pratos que o aplicativo espera."""
    if not isinstance(raw_recipes, list):
        raise ValueError(f"Lista de pratos inválida em {context}.")
    selected: list[dict[str, Any]] = []
    for course, expected in COURSE_COUNTS.items():
        matches = [
            recipe
            for recipe in raw_recipes
            if isinstance(recipe, dict) and str(recipe.get("curso", "")).strip().lower() == course
        ]
        if len(matches) < expected:
            raise ValueError(
                f"{context}: esperado(s) {expected} prato(s) de {course}, recebido(s) {len(matches)}."
            )
        selected.extend(matches[:expected])
    return selected


def generate() -> dict[str, Any]:
    print(f"[{DATE_BR}] Pesquisando candidatos com {MODEL}…", flush=True)
    candidates = call_gemini(candidate_prompt(), 0.45)
    print("Curando cardápio…", flush=True)
    result = call_gemini(curator_prompt(candidates), 0.25)
    if not isinstance(result, dict):
        raise ValueError("O modelo não devolveu um objeto de cardápio.")
    print("Validando links e fotos nas páginas de origem…", flush=True)
    if MODE == "semanal":
        days = result.get("dias", [])
        if not isinstance(days, list) or len(days) < 7:
            raise ValueError("O cardápio semanal precisa conter os sete dias.")
        result["dias"] = days[:7]
        for day in result["dias"]:
            chosen = select_menu_recipes(day.get("pratos", []), str(day.get("dia", "dia")))
            day["pratos"] = [enrich_recipe(recipe) for recipe in chosen]
    else:
        chosen = select_menu_recipes(result.get("pratos", []), "cardápio diário")
        result["pratos"] = [enrich_recipe(recipe) for recipe in chosen]

    recipes = every_recipe(result)
    image_count = sum(bool(recipe.get("imagem", {}).get("url")) for recipe in recipes)
    if image_count == 0:
        raise ValueError(
            "Nenhuma imagem foi encontrada. Confira o secret PEXELS_KEY (ou PEXELS_API_KEY)."
        )
    if image_count < len(recipes):
        print(
            f"::warning::{len(recipes) - image_count} prato(s) ficaram sem foto; "
            f"{image_count}/{len(recipes)} receberam imagem.",
            flush=True,
        )
    return result


def every_recipe(menu: dict[str, Any]) -> list[dict[str, Any]]:
    if menu.get("tipo") == "semanal":
        return [recipe for day in menu.get("dias", []) for recipe in day.get("pratos", [])]
    return menu.get("pratos", [])


def persist(menu: dict[str, Any]) -> None:
    document = load_json(RECIPES_FILE, {})
    document["gerado_em"] = NOW.isoformat(timespec="seconds")
    document["versao_schema"] = 2
    document["semanal" if menu.get("tipo") == "semanal" else "diario"] = menu
    save_json(RECIPES_FILE, document)

    history = load_json(HISTORY_FILE, [])
    known = {item.get("id") for item in history}
    for recipe in every_recipe(menu):
        if recipe.get("id") not in known:
            history.append({
                "id": recipe["id"],
                "titulo": recipe.get("nome", ""),
                "tags": recipe.get("tags", []),
                "data": DATE_BR,
                "fonte_status": recipe.get("fonte", {}).get("status"),
            })
            known.add(recipe["id"])
    save_json(HISTORY_FILE, history[-600:])


def render_recipe(recipe: dict[str, Any]) -> str:
    ingredients = "".join(f"<li>{html.escape(str(item))}</li>" for item in recipe.get("ingredientes", []))
    steps = "".join(f"<li>{html.escape(str(step))}</li>" for step in recipe.get("preparo", []))
    source = recipe.get("fonte", {})
    link = (
        f'<p><a href="{html.escape(source["url"])}">Abrir fonte verificada em '
        f'{html.escape(source.get("domain", "site original"))}</a></p>'
        if source.get("status") == "verified" and source.get("url")
        else "<p><em>Fonte direta não confirmada; o app oferece uma busca segura pelo nome.</em></p>"
    )
    return f"""
<article style="margin:18px 0 28px">
  <h3 style="margin:0 0 4px">{html.escape(recipe.get("nome", ""))}</h3>
  <p style="color:#66706c;margin:0 0 10px">{html.escape(recipe.get("tempo", ""))} · {html.escape(recipe.get("porque", ""))}</p>
  <h4>Ingredientes</h4><ul>{ingredients}</ul>
  <h4>Preparo</h4><ol>{steps}</ol>
  {link}
</article>
""".strip()


def render_email(menu: dict[str, Any]) -> str:
    if menu.get("tipo") == "semanal":
        sections = []
        for day in menu.get("dias", []):
            sections.append(
                f'<h2 style="border-bottom:1px solid #d9d5ca;padding-bottom:7px">{html.escape(day.get("dia", ""))}</h2>'
                + "".join(render_recipe(recipe) for recipe in day.get("pratos", []))
            )
        title = f"Cardápio da semana · {menu.get('periodo', '')}"
        content = "".join(sections)
    else:
        title = f"Jantar de {menu.get('dia_semana', 'hoje')} · {menu.get('data', DATE_BR)}"
        content = "".join(render_recipe(recipe) for recipe in menu.get("pratos", []))
    app_link = f'<p><a href="{html.escape(APP_URL)}" style="color:#173f35;font-weight:bold">Abrir o app</a></p>' if APP_URL else ""
    return f"""
<!doctype html>
<html lang="pt-BR">
<body style="font-family:Arial,sans-serif;color:#17221f;line-height:1.5;max-width:680px;margin:auto;padding:20px">
  <div style="background:#173f35;color:white;border-radius:18px;padding:22px">
    <div style="color:#f6b958;font-size:12px;text-transform:uppercase;letter-spacing:.1em">Cozinha · Ana &amp; Rafael</div>
    <h1 style="margin:8px 0 0">{html.escape(title)}</h1>
  </div>
  {app_link}
  {content}
  <p style="color:#66706c;font-size:12px;margin-top:32px">Gerado e verificado automaticamente em {DATE_BR}.</p>
</body>
</html>
""".strip()


def send_email(menu: dict[str, Any]) -> None:
    subject = (
        f"🍽️ Cardápio da semana ({WEEK_PERIOD})"
        if menu.get("tipo") == "semanal"
        else f"🍽️ Jantar de {DAY_NAME} — {DATE_BR}"
    )
    message = MIMEMultipart("alternative")
    message["Subject"] = subject
    message["From"] = formataddr(("Cozinha", GMAIL_ADDRESS))
    message["To"] = ", ".join(RECIPIENTS)
    message.attach(MIMEText("Abra este e-mail em um leitor com HTML.", "plain", "utf-8"))
    message.attach(MIMEText(render_email(menu), "html", "utf-8"))
    with smtplib.SMTP_SSL("smtp.gmail.com", 465, context=ssl.create_default_context()) as server:
        server.login(GMAIL_ADDRESS, GMAIL_APP_PASSWORD)
        server.sendmail(GMAIL_ADDRESS, RECIPIENTS, message.as_string())


def main() -> int:
    menu = generate()
    if MODE == "semanal" and not menu.get("dias"):
        raise ValueError("Cardápio semanal vazio.")
    if MODE != "semanal" and not menu.get("pratos"):
        raise ValueError("Cardápio diário vazio.")
    persist(menu)
    send_email(menu)
    verified = sum(recipe.get("fonte", {}).get("status") == "verified" for recipe in every_recipe(menu))
    print(f"OK: dados gravados, e-mail enviado e {verified} fonte(s) verificada(s).", flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # noqa: BLE001
        print(f"ERRO: {exc}", file=sys.stderr)
        raise
