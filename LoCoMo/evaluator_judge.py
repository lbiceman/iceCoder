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


# ---------------------------------------------------------------------------
# Memory Extraction via LLM
# ---------------------------------------------------------------------------

EXTRACT_SYSTEM_PROMPT = """You are a memory extraction system. Your task is to analyze a conversation and extract the MOST IMPORTANT facts as compact memory items.

Rules:
1. Each memory item should be a SELF-CONTAINED fact or a group of closely related facts about the same topic.
2. MERGE related facts into ONE item. For example:
   - "Person has pets Oliver (cat) and Bailey (cat)" → ONE item, not two
   - "Person went camping at beach, mountains, and forest" → ONE item listing all locations
   - "Person A and Person B are friends who support each other" → ONE item
3. Convert relative time references to absolute dates using the conversation date.
4. For EVERY fact, explicitly state WHEN it happened with an absolute date.
5. Include WHO, WHAT, WHEN, WHERE details explicitly.
6. Preserve exact names, dates, numbers — never paraphrase.
7. AIM FOR 4-6 ITEMS PER CONVERSATION SESSION. Only extract what is truly important and distinct.
8. Prioritize: events with specific dates > personal facts > preferences > opinions > casual remarks.
9. Return a JSON array of objects, each with: "name", "description", "content", "tags", "eventDate"
10. Return ONLY the JSON array, no other text, no code blocks."""

EXTRACT_USER_TEMPLATE = """Conversation date/time: {datetime}
Participants: {speaker_a} and {speaker_b}

Conversation:
{transcript}

Extract the MOST IMPORTANT facts, events, preferences, and relationships. MERGE related facts into single items.
Target: 4-6 items for this conversation segment. Quality over quantity.

Return a JSON array where each item has:
- "name": short descriptive title WITH date (e.g., "Caroline attended LGBTQ support group on 7 May 2023")
- "description": one-sentence summary with ALL key details — be SPECIFIC and SEARCHABLE
- "content": full description with all specifics (who, what, when, where). Include multiple related facts in one content block.
- "tags": array of relevant tags (people names, topics, exact dates in YYYY-MM-DD format)
- "eventDate": YYYY-MM-DD format date when this event/fact occurred (null if not time-specific)

The "name" and "description" fields are critical — they will be used to match this memory to future queries. Make them specific and searchable."""


def extract_memories_from_session(
    transcript: str,
    datetime_str: str,
    speaker_a: str,
    speaker_b: str,
    cfg: Optional[dict] = None,
) -> list:
    """
    Use LLM to extract individual fact items from a conversation session.
    For long transcripts (>5000 chars), splits into chunks and extracts from each,
    then deduplicates by name similarity.
    Returns a list of dicts with name, description, content, tags, eventDate.
    """
    if cfg is None:
        cfg = _get_config()

    MAX_CHUNK = 5000

    if len(transcript) <= MAX_CHUNK:
        return _extract_single_chunk(transcript, datetime_str, speaker_a, speaker_b, cfg)

    # Split long transcripts by turn boundaries
    chunks = _split_transcript_into_chunks(transcript, MAX_CHUNK)
    all_facts = []
    for i, chunk in enumerate(chunks):
        chunk_hint = f"(Part {i+1}/{len(chunks)}) " if len(chunks) > 1 else ""
        facts = _extract_single_chunk(
            chunk, datetime_str, speaker_a, speaker_b, cfg, chunk_hint=chunk_hint
        )
        all_facts.extend(facts)

    # Deduplicate by name similarity
    return _deduplicate_facts(all_facts)


def _split_transcript_into_chunks(transcript: str, max_chars: int) -> list:
    """Split transcript at turn boundaries (speaker lines) to stay under max_chars."""
    lines = transcript.split('\n')
    chunks = []
    current_chunk_lines = []
    current_len = 0

    for line in lines:
        line_len = len(line) + 1  # +1 for newline
        if current_len + line_len > max_chars and current_chunk_lines:
            chunks.append('\n'.join(current_chunk_lines))
            current_chunk_lines = []
            current_len = 0
        current_chunk_lines.append(line)
        current_len += line_len

    if current_chunk_lines:
        chunks.append('\n'.join(current_chunk_lines))

    return chunks


def _deduplicate_facts(facts: list) -> list:
    """Remove near-duplicate facts by comparing normalized names."""
    if not facts:
        return facts

    seen_names = set()
    unique = []
    for fact in facts:
        name = fact.get("name", "").lower().strip()
        # Simple dedup: skip if exact name match
        if name in seen_names:
            continue
        # Check for high overlap with existing names (>80% word overlap)
        is_dup = False
        name_words = set(name.split())
        if len(name_words) >= 2:
            for seen in seen_names:
                seen_words = set(seen.split())
                if not seen_words:
                    continue
                overlap = len(name_words & seen_words)
                union = len(name_words | seen_words)
                if union > 0 and overlap / union > 0.8:
                    is_dup = True
                    break
        if not is_dup:
            seen_names.add(name)
            unique.append(fact)

    return unique


def _extract_single_chunk(
    transcript: str,
    datetime_str: str,
    speaker_a: str,
    speaker_b: str,
    cfg: dict,
    chunk_hint: str = "",
) -> list:
    """Extract facts from a single transcript chunk via LLM."""
    prompt = EXTRACT_USER_TEMPLATE.format(
        datetime=datetime_str or "unknown",
        speaker_a=speaker_a,
        speaker_b=speaker_b,
        transcript=transcript[:6000],
    )
    if chunk_hint:
        prompt = f"Note: This is {chunk_hint}of a longer conversation. Extract all facts from this segment.\n\n{prompt}"

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
            {"role": "system", "content": EXTRACT_SYSTEM_PROMPT},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.2,
        "max_tokens": 4096,
    }

    for attempt in range(MAX_RETRIES):
        try:
            resp = requests.post(url, headers=headers, json=payload, timeout=60)
            if resp.status_code == 429:
                wait = min(RETRY_DELAY * (attempt + 1), 10)
                logger.warning(f"Rate limited during extraction, waiting {wait}s...")
                time.sleep(wait)
                continue
            resp.raise_for_status()
            data = resp.json()
            content = data["choices"][0]["message"]["content"].strip()

            # Parse JSON array
            if content.startswith("```"):
                content = re.sub(r"^```(?:json)?\s*", "", content)
                content = re.sub(r"\s*```$", "", content)

            items = json.loads(content)
            if isinstance(items, list):
                return items
            logger.warning(f"Extraction returned non-list: {type(items)}")
            return []

        except requests.RequestException as e:
            logger.warning(f"Extraction API attempt {attempt+1} failed: {e}")
            if attempt < MAX_RETRIES - 1:
                time.sleep(RETRY_DELAY)
        except (json.JSONDecodeError, KeyError, IndexError) as e:
            logger.warning(f"Extraction parse error: {e}")
            if attempt < MAX_RETRIES - 1:
                time.sleep(RETRY_DELAY)

    return []
