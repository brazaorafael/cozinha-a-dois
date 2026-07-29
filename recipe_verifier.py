"""Validação de fontes e imagens para o projeto Cozinha.

A regra é deliberadamente conservadora: uma URL só vira link direto quando
responde, pertence a um domínio permitido, contém sinais de receita e o título
corresponde ao nome do prato. Ausência de foto confiável não é erro; o frontend
mostra uma capa tipográfica honesta.
"""

from __future__ import annotations

import hashlib
import html
import json
import os
import re
import unicodedata
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urljoin, urlparse

import requests

DEFAULT_HOSTS = (
    "panelinha.com.br",
    "receitas.globo.com",
    "tudogostoso.com.br",
)
USER_AGENT = "Mozilla/5.0 (compatible; CozinhaRecipeVerifier/2.0)"
STOP_WORDS = {
    "receita", "facil", "rapida", "rapido", "caseiro", "caseira", "como",
    "fazer", "para", "com", "uma", "por", "dos", "das", "de", "da", "do", "e",
}


def normalize(value: Any) -> str:
    text = unicodedata.normalize("NFD", str(value or "").lower())
    text = "".join(char for char in text if unicodedata.category(char) != "Mn")
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9\s]", " ", text)).strip()


def useful_tokens(value: Any) -> list[str]:
    return [token for token in normalize(value).split() if len(token) > 2 and token not in STOP_WORDS]


def allowed_hosts() -> tuple[str, ...]:
    configured = [
        host.strip().lower().removeprefix("www.")
        for host in os.environ.get("ALLOWED_RECIPE_HOSTS", "").split(",")
        if host.strip()
    ]
    return tuple(configured or DEFAULT_HOSTS)


def safe_recipe_url(raw_url: Any) -> str:
    try:
        parsed = urlparse(str(raw_url or "").strip())
    except ValueError:
        return ""
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password or parsed.port:
        return ""
    host = parsed.hostname.lower().removeprefix("www.")
    if not any(host == allowed or host.endswith("." + allowed) for allowed in allowed_hosts()):
        return ""
    return parsed.geturl()


def safe_image_url(raw_url: Any, base_url: str = "") -> str:
    if not raw_url:
        return ""
    try:
        resolved = urljoin(base_url, str(raw_url))
        parsed = urlparse(resolved)
    except ValueError:
        return ""
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        return ""
    return resolved


def title_similarity(name: str, title: str) -> float:
    name_tokens = useful_tokens(name)
    title_tokens = set(useful_tokens(title))
    if not name_tokens or not title_tokens:
        return 0.0
    matches = sum(token in title_tokens for token in name_tokens)
    coverage = matches / len(name_tokens)
    bonus = 0.16 if matches >= min(2, len(name_tokens)) else 0
    return min(1.0, coverage * 0.84 + bonus)


def _first_match(text: str, patterns: list[str]) -> str:
    for pattern in patterns:
        match = re.search(pattern, text, re.I | re.S)
        if match:
            return html.unescape(re.sub(r"\s+", " ", match.group(1))).strip()
    return ""


def _meta(html_text: str, property_name: str) -> str:
    prop = re.escape(property_name)
    return _first_match(
        html_text,
        [
            rf'<meta[^>]+(?:property|name)=["\']{prop}["\'][^>]+content=["\']([^"\']+)["\']',
            rf'<meta[^>]+content=["\']([^"\']+)["\'][^>]+(?:property|name)=["\']{prop}["\']',
        ],
    )


def _flatten_ld(value: Any) -> list[dict[str, Any]]:
    if isinstance(value, list):
        out: list[dict[str, Any]] = []
        for item in value:
            out.extend(_flatten_ld(item))
        return out
    if not isinstance(value, dict):
        return []
    return [value, *_flatten_ld(value.get("@graph", []))]


def _recipe_schema(html_text: str) -> dict[str, Any] | None:
    blocks = re.findall(
        r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>([\s\S]*?)</script>',
        html_text,
        re.I,
    )
    for block in blocks[:20]:
        try:
            data = json.loads(html.unescape(block.strip()))
        except (json.JSONDecodeError, TypeError):
            continue
        for item in _flatten_ld(data):
            types = item.get("@type", [])
            if not isinstance(types, list):
                types = [types]
            if any(str(kind).lower() == "recipe" for kind in types):
                return item
    return None


def _instructions(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    result: list[str] = []
    for step in value:
        if isinstance(step, str):
            result.append(re.sub(r"<[^>]*>", " ", step))
        elif isinstance(step, dict) and isinstance(step.get("itemListElement"), list):
            result.extend(_instructions(step["itemListElement"]))
        elif isinstance(step, dict) and step.get("text"):
            result.append(re.sub(r"<[^>]*>", " ", str(step["text"])))
    return [re.sub(r"\s+", " ", step).strip() for step in result if step.strip()][:20]


def verify_recipe_page(name: str, raw_url: Any) -> dict[str, Any] | None:
    url = safe_recipe_url(raw_url)
    if not url:
        return None
    try:
        response = requests.get(
            url,
            headers={"User-Agent": USER_AGENT, "Accept": "text/html,application/xhtml+xml"},
            timeout=(4, 7),
            allow_redirects=True,
        )
        response.raise_for_status()
    except requests.RequestException:
        return None
    if "text/html" not in response.headers.get("content-type", ""):
        return None
    if len(response.content) > 2_000_000:
        return None

    text = response.text
    schema = _recipe_schema(text)
    title = html.unescape(str(
        (schema or {}).get("name")
        or _meta(text, "og:title")
        or _first_match(text, [r"<title[^>]*>([\s\S]*?)</title>"])
    ))
    similarity = title_similarity(name, title)
    evidence = bool(
        schema
        or re.search(r'itemtype=["\'][^"\']*schema\.org/Recipe', text, re.I)
        or re.search(r"ingredientes|modo de preparo|ingredients|instructions", text, re.I)
    )
    if similarity < 0.42 or not evidence:
        return None

    canonical_raw = _first_match(
        text,
        [
            r'<link[^>]+rel=["\']canonical["\'][^>]+href=["\']([^"\']+)["\']',
            r'<link[^>]+href=["\']([^"\']+)["\'][^>]+rel=["\']canonical["\']',
        ],
    )
    canonical = safe_recipe_url(urljoin(response.url, canonical_raw)) or safe_recipe_url(response.url)
    if not canonical:
        return None

    schema_image = (schema or {}).get("image", "")
    if isinstance(schema_image, list):
        schema_image = schema_image[0] if schema_image else ""
    if isinstance(schema_image, dict):
        schema_image = schema_image.get("url", "")
    image = safe_image_url(
        schema_image or _meta(text, "og:image") or _meta(text, "twitter:image"),
        response.url,
    )

    ingredients = (schema or {}).get("recipeIngredient", [])
    if not isinstance(ingredients, list):
        ingredients = []
    return {
        "url": canonical,
        "title": re.sub(r"\s+", " ", re.sub(r"<[^>]*>", " ", title)).strip()[:220],
        "domain": urlparse(canonical).hostname.removeprefix("www."),
        "confidence": round(similarity, 2),
        "image": image,
        "total_time": str((schema or {}).get("totalTime", "")),
        "ingredients": [str(item) for item in ingredients[:60]],
        "instructions": _instructions((schema or {}).get("recipeInstructions")),
    }


def pexels_image(name: str) -> dict[str, Any] | None:
    """Plano B opcional e sempre rotulado como imagem ilustrativa."""
    key = os.environ.get("PEXELS_KEY", "").strip()
    enabled = os.environ.get("ENABLE_PEXELS_FALLBACK", "false").lower() == "true"
    if not key or not enabled:
        return None
    try:
        response = requests.get(
            "https://api.pexels.com/v1/search",
            params={
                "query": f"{name} comida prato",
                "per_page": 12,
                "orientation": "landscape",
                "locale": "pt-BR",
            },
            headers={"Authorization": key},
            timeout=(3, 6),
        )
        response.raise_for_status()
        photos = response.json().get("photos", [])
    except (requests.RequestException, ValueError):
        return None
    tokens = useful_tokens(name)
    ranked = sorted(
        photos,
        key=lambda photo: sum(token in normalize(photo.get("alt", "")) for token in tokens),
        reverse=True,
    )
    if not ranked:
        return None
    best = ranked[0]
    score = sum(token in normalize(best.get("alt", "")) for token in tokens)
    if score < 1:
        return None
    return {
        "kind": "bank",
        "url": best.get("src", {}).get("large") or best.get("src", {}).get("medium", ""),
        "alt": best.get("alt") or name,
        "bank_id": str(best.get("id", "")),
        "credit": best.get("photographer", "Pexels"),
    }


def recipe_id(name: str, source_url: str = "") -> str:
    base = re.sub(r"[^a-z0-9]+", "-", normalize(name)).strip("-")[:48] or "prato"
    suffix = hashlib.sha1(f"{normalize(name)}|{source_url}".encode()).hexdigest()[:8]
    return f"{base}-{suffix}"


def enrich_recipe(raw: dict[str, Any]) -> dict[str, Any]:
    recipe = {
        "nome": str(raw.get("nome") or raw.get("titulo") or "").strip()[:180],
        "curso": str(raw.get("curso") or "principal").lower(),
        "tempo": str(raw.get("tempo") or "").strip()[:40],
        "porque": str(raw.get("porque") or "").strip()[:400],
        "tags": [normalize(tag).replace(" ", "_") for tag in raw.get("tags", [])][:8],
        "rende_sobra": bool(raw.get("rende_sobra")),
        "ingredientes": [str(item).strip() for item in raw.get("ingredientes", []) if str(item).strip()][:80],
        "preparo": [str(step).strip() for step in raw.get("preparo", []) if str(step).strip()][:20],
    }
    if recipe["curso"] not in {"principal", "entrada", "sobremesa"}:
        recipe["curso"] = "principal"

    verified = verify_recipe_page(recipe["nome"], raw.get("url"))
    checked_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    if verified:
        recipe["fonte"] = {
            "status": "verified",
            "url": verified["url"],
            "title": verified["title"],
            "domain": verified["domain"],
            "confidence": verified["confidence"],
            "checked_at": checked_at,
        }
        recipe["imagem"] = (
            {"kind": "source", "url": verified["image"], "alt": recipe["nome"]}
            if verified["image"]
            else {"kind": "none", "url": "", "alt": recipe["nome"]}
        )
        recipe["tempo"] = recipe["tempo"] or verified["total_time"]
        recipe["ingredientes"] = recipe["ingredientes"] or verified["ingredients"]
        recipe["preparo"] = recipe["preparo"] or verified["instructions"]
    else:
        suggested = safe_recipe_url(raw.get("url"))
        recipe["fonte"] = {
            "status": "unverified",
            "url": "",
            "suggested_url": suggested,
            "checked_at": checked_at,
        }
        recipe["imagem"] = pexels_image(recipe["nome"]) or {
            "kind": "none",
            "url": "",
            "alt": recipe["nome"],
        }
    recipe["id"] = recipe_id(recipe["nome"], recipe["fonte"].get("url", ""))
    return recipe
