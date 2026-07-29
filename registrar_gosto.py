#!/usr/bin/env python3
"""Registra votos de forma idempotente e recalcula o perfil.

Ao contrário de somar indefinidamente, cada receita possui um estado atual:
like, dislike ou removido. Assim, trocar de opinião não distorce os contadores.
"""

from __future__ import annotations

import datetime as dt
import json
import os
from collections import Counter
from pathlib import Path
from typing import Any

DATA_DIR = Path("data")
PROFILE_FILE = DATA_DIR / "perfil_gostos.json"
LIST_FILE = DATA_DIR / "lista_final.json"
NOW = dt.datetime.now(dt.timezone(dt.timedelta(hours=-3))).isoformat(timespec="seconds")


def load(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return fallback


def save(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def summary(counters: dict[str, int]) -> str:
    positive = [tag.replace("_", " ") for tag, score in sorted(counters.items(), key=lambda item: -item[1]) if score > 0][:6]
    negative = [tag.replace("_", " ") for tag, score in sorted(counters.items(), key=lambda item: item[1]) if score < 0][:6]
    parts = []
    if positive:
        parts.append("curtem: " + ", ".join(positive))
    if negative:
        parts.append("evitam: " + ", ".join(negative))
    return "; ".join(parts)


def main() -> int:
    payload = json.loads(os.environ.get("PAYLOAD", "{}"))
    vote = str(payload.get("voto", "")).lower()
    recipe = payload.get("receita") or {}
    recipe_id = recipe.get("id")
    event_id = str(payload.get("event_id") or "")
    if not recipe_id or vote not in {"like", "dislike", "remove"}:
        print("Payload incompleto; nada foi alterado.")
        return 0

    profile = load(PROFILE_FILE, {})
    votes = profile.setdefault("votos", {})
    processed = profile.setdefault("eventos_processados", [])
    if event_id and event_id in processed:
        print("Evento repetido; nada foi alterado.")
        return 0

    if vote == "remove":
        votes.pop(recipe_id, None)
    else:
        votes[recipe_id] = {
            "voto": vote,
            "receita": recipe,
            "atualizado_em": NOW,
        }

    if event_id:
        processed.append(event_id)
        profile["eventos_processados"] = processed[-250:]

    counters: Counter[str] = Counter()
    liked = []
    rejected = []
    liked_recipes = []
    for current_id, record in votes.items():
        current_recipe = record.get("receita") or {}
        current_vote = record.get("voto")
        weight = 1 if current_vote == "like" else -1
        for tag in current_recipe.get("tags", []):
            counters[str(tag)] += weight
        compact = {
            "id": current_id,
            "titulo": current_recipe.get("nome") or current_recipe.get("titulo") or "",
            "tags": current_recipe.get("tags", []),
            "data": record.get("atualizado_em", NOW),
        }
        if current_vote == "like":
            liked.append(compact)
            liked_recipes.append(current_recipe)
        else:
            rejected.append(compact)

    profile.update({
        "curtidas": liked,
        "rejeitadas": rejected,
        "contadores": dict(counters),
        "resumo": summary(dict(counters)),
        "atualizado_em": NOW,
    })
    save(PROFILE_FILE, profile)
    save(LIST_FILE, {"itens": liked_recipes, "atualizado_em": NOW})
    print(f"Voto atual de {recipe_id}: {vote}. Perfil recalculado.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
