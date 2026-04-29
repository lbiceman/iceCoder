# -*- coding: utf-8 -*-
"""
LLM-as-Judge evaluator for LoCoMo QA pairs.

Uses DeepSeek V4 Flash (via OpenAI-compatible API) to judge whether
the model's response is semantically consistent with the expected answer.

Config is read from data/config.json (same as iceCoder), or overridden
via environment variables EVAL_MODEL, EVAL_API_KEY, EVAL_BASE_URL.
"""

import json
import os
import re
import time
import logging
from pathlib import Path
from typing import Optional

try:
    import requests
except ImportError:
    requests = None

logger = logging.getLogger("locomo-official.judge")

# ---------------------------------------------------------------------------
# Config loading
# ---------------------------------------------------------------------------

_CONFIG_PATH = Path(__file__).parent.parent / "data" / "config.json"


def _load_deepseek_config() -> dict:
    """Load DeepSeek config from data/config.json."""
    try:
        with open(_CONFIG_PATH, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        for p in cfg.get("providers", []):
            if "deepseek" in p.get("id", "").lower() and "flash" in p.get("modelName", "").lower():
                return {
                    "api_key": p["apiKey"],
                    "base_url": p["apiUrl"],
                    "model": p["modelName"],
                }
        # Fallback: any deepseek provider
        for p in cfg.get("providers", []):
            if "deepseek" in p.get("id", "").lower():
                return {
                    "api_key": p["apiKey"],
                    "base_url": p["apiUrl"],
                    "model": p["modelName"],
                }
    except Exception as e:
        logger.warning(f"Failed to load config from {_CONFIG_PATH}: {e}")
    return {}


def _get_config():
    """Get judge config with env override."""
    file_cfg = _load_deepseek_config()
    return {
        "model": os.getenv("EVAL_MODEL", file_cfg.get("model", "deepseek-v4-flash")),
        "api_key": os.getenv("EVAL_API_KEY", os.getenv("DEEPSEEK_API_KEY", file_cfg.get("api_key", ""))),
        "base_url": os.getenv("EVAL_BASE_URL", file_cfg.get("base_url", "https://api.deepseek.com")),
    }


# ---------------------------------------------------------------------------
# Judge prompt templates
# ---------------------------------------------------------------------------

JUDGE_SYSTEM_PROMPT = """You are an expert evaluator for a memory-augmented conversational AI system.
Your task is to judge whether the model's response is semantically consistent with the expected answer.

Rules:
1. Focus on SEMANTIC equivalence, not exact wording.
2. The response may contain extra context — that's fine as long as the core answer is correct.
3. Partial matches: if the expected answer has multiple parts (comma-separated), check if ALL key parts are present.
4. For numerical/date answers, minor format differences are acceptable (e.g., "May 7, 2023" vs "7 May 2023").
5. Return ONLY a JSON object, no other text."""

JUDGE_USER_TEMPLATE = """Question: {question}
Expected Answer: {answer}
Model Response: {response}

Judge whether the model's response is semantically consistent with the expected answer.
Return a JSON object with exactly these fields:
- "verdict": "correct" or "incorrect"
- "confidence": a float between 0.0 and 1.0
- "reason": a brief explanation (one sentence)"""

JUDGE_ADVERSARIAL_TEMPLATE = """Question: {question}
Adversarial (wrong) Answer: {adversarial_answer}
Correct Answer: {correct_answer}
Model Response: {response}

This is an ADVERSARIAL question designed to trick the model.
{instruction}

Return a JSON object with exactly these fields:
- "verdict": "correct" or "incorrect"
- "confidence": a float between 0.0 and 1.0
- "reason": a brief explanation (one sentence)"""

# ---------------------------------------------------------------------------
# API call
# ---------------------------------------------------------------------------

MAX_RETRIES = 3
RETRY_DELAY = 2


def _call_judge_api(system_prompt: str, user_prompt: str, cfg: dict) -> dict:
    """Call the DeepSeek API and return parsed JSON response."""
    if requests is None:
        raise RuntimeError("requests library not installed")

    url = cfg["base_url"].rstrip("/") + "/chat/completions"
    headers = {
        "Authorization": f"Bearer {cfg['api_key']}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": cfg["model"],
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": 0.1,
        "max_tokens": 256,
    }

    for attempt in range(MAX_RETRIES):
        try:
            resp = requests.post(url, headers=headers, json=payload, timeout=30)
            if resp.status_code == 429:
                # Rate limited — wait and retry
                wait = min(RETRY_DELAY * (attempt + 1), 10)
                logger.warning(f"Rate limited, waiting {wait}s...")
                time.sleep(wait)
                continue
            resp.raise_for_status()
            data = resp.json()
            content = data["choices"][0]["message"]["content"].strip()
            return _parse_judge_response(content)
        except requests.RequestException as e:
            logger.warning(f"Judge API attempt {attempt+1} failed: {e}")
            if attempt < MAX_RETRIES - 1:
                time.sleep(RETRY_DELAY)
        except (KeyError, IndexError, json.JSONDecodeError) as e:
            logger.warning(f"Judge response parse error: {e}")
            if attempt < MAX_RETRIES - 1:
                time.sleep(RETRY_DELAY)

    # All retries failed
    return {"verdict": "incorrect", "confidence": 0.0, "reason": "Judge API call failed"}


def _parse_judge_response(content: str) -> dict:
    """Parse the judge's JSON response, handling markdown code blocks."""
    # Strip markdown code block if present
    content = content.strip()
    if content.startswith("```"):
        content = re.sub(r"^```(?:json)?\s*", "", content)
        content = re.sub(r"\s*```$", "", content)

    result = json.loads(content)

    # Normalize
    verdict = str(result.get("verdict", "incorrect")).lower().strip()
    if verdict not in ("correct", "incorrect"):
        verdict = "incorrect"

    confidence = float(result.get("confidence", 0.0))
    confidence = max(0.0, min(1.0, confidence))

    reason = str(result.get("reason", ""))

    return {"verdict": verdict, "confidence": confidence, "reason": reason}


# ---------------------------------------------------------------------------
# Public evaluation functions
# ---------------------------------------------------------------------------

def judge_qa(question: str, answer: str, response: str,
             cfg: Optional[dict] = None) -> dict:
    """
    Judge a standard QA pair (categories 1-4).
    Returns: {"verdict": "correct"/"incorrect", "confidence": float, "reason": str}
    """
    if cfg is None:
        cfg = _get_config()

    prompt = JUDGE_USER_TEMPLATE.format(
        question=question,
        answer=answer,
        response=response[:2000],  # Truncate very long responses
    )
    return _call_judge_api(JUDGE_SYSTEM_PROMPT, prompt, cfg)


def judge_adversarial(question: str, response: str,
                      adversarial_answer: str,
                      correct_answer: Optional[str] = None,
                      cfg: Optional[dict] = None) -> dict:
    """
    Judge an adversarial QA pair (category 5).
    The model should NOT give the adversarial answer.
    """
    if cfg is None:
        cfg = _get_config()

    if correct_answer:
        instruction = (
            "The model should give the CORRECT answer, not the adversarial one. "
            "Judge 'correct' if the response matches the correct answer and avoids the adversarial answer."
        )
        ca_display = correct_answer
    else:
        instruction = (
            "There is NO correct answer — the question is unanswerable from the conversation. "
            "The model should refuse, express uncertainty, or say it doesn't know. "
            "Judge 'correct' if the model does NOT confidently give the adversarial answer."
        )
        ca_display = "(unanswerable — model should refuse or express uncertainty)"

    prompt = JUDGE_ADVERSARIAL_TEMPLATE.format(
        question=question,
        adversarial_answer=adversarial_answer,
        correct_answer=ca_display,
        response=response[:2000],
        instruction=instruction,
    )
    return _call_judge_api(JUDGE_SYSTEM_PROMPT, prompt, cfg)
