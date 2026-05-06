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
    """Parse the judge's JSON response, handling markdown code blocks and parse failures."""
    # Strip markdown code block if present
    content = content.strip()
    if content.startswith("```"):
        content = re.sub(r"^```(?:json)?\s*", "", content)
        content = re.sub(r"\s*```$", "", content)

    try:
        result = json.loads(content)
    except (json.JSONDecodeError, ValueError):
        # Regex fallback: extract verdict and confidence from malformed JSON
        verdict_m = re.search(r'"verdict"\s*:\s*"(correct|incorrect)"', content, re.IGNORECASE)
        conf_m = re.search(r'"confidence"\s*:\s*([\d.]+)', content)
        reason_m = re.search(r'"reason"\s*:\s*"([^"]*)"', content)
        if verdict_m:
            return {
                "verdict": verdict_m.group(1).lower(),
                "confidence": float(conf_m.group(1)) if conf_m else 0.5,
                "reason": reason_m.group(1) if reason_m else "Parsed via regex fallback",
            }
        return {"verdict": "incorrect", "confidence": 0.0, "reason": f"JSON parse failed: {content[:200]}"}

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

EXTRACT_SYSTEM_PROMPT = """You are a memory extraction system. Your task is to analyze a conversation and extract EVERY DISTINCT FACT as a separate memory item.

Rules:
1. ATOMIC EXTRACTION: Each memory item must contain exactly ONE piece of information. Do NOT combine multiple facts into one item.
   - WRONG: "James's pets and training" combining dog names + training tricks + adoption date
   - RIGHT: "James has a dog named Max" (one fact), "James has a dog named Daisy" (another fact), "James trained his dogs to sit and stay" (another fact)
2. NO ITEM COUNT LIMIT. Extract as many items as needed to capture ALL information. A typical session may produce 15-30 items.
3. Convert relative time references to absolute dates using the session date provided.
4. For EVERY fact, explicitly state WHEN it happened with an absolute date.
5. Include WHO, WHAT, WHEN, WHERE details explicitly.
6. Preserve exact names, dates, numbers — never paraphrase.
7. Prioritize: events with specific dates > personal facts > preferences > opinions > casual remarks.
8. Return a JSON array of objects, each with: "name", "description", "content", "tags", "eventDate"
9. Return ONLY the JSON array, no other text, no code blocks.

## CRITICAL: Atomic fact extraction
Extract EACH fact as its OWN item. Do NOT group by topic. Examples:
- "James has a dog named Max" → one item
- "James has a dog named Daisy" → one item
- "James trained his dogs to sit, stay, paw, and rollover" → one item (list of tricks)
- "James adopted a puppy named Ned from Stamford shelter in April 2022" → one item
- "John started playing drums in February 2022" → one item
- "John plays CS:GO" → one item
- "John organized a charity tournament on May 7, 2022" → one item
Each item should be a SINGLE, searchable fact that can answer a specific question.

## CRITICAL: Preserve specific details
- Book titles, song names, movie names — quote them EXACTLY (e.g., "The Name of the Wind", "Charlotte's Web")
- Pet names, people names — spell them exactly as mentioned, list ALL of them
- Exact numbers: ages, distances, counts, years (e.g., "4 years", "10 years ago", "3 children")
- Specific dates and durations — convert ALL relative dates to absolute
- Hobbies, instruments, sports — list each one mentioned

## MANDATORY: List completeness
When a conversation mentions a LIST of items (games, countries, tricks, books, food, names), you MUST include ALL items in a single memory entry. NEVER truncate a list.
- "I have cats named Oliver, Luna, and Bailey" → ONE item listing ALL THREE names
- "I read 'Nothing is Impossible' and 'Charlotte's Web'" → ONE item listing BOTH titles
- "He can do sit, stay, paw, rollover, swim, catch frisbees, and balance on skateboard" → ONE item listing ALL 7 tricks
If you mention one item from a list, you MUST mention all.

## MANDATORY: Absolute date conversion
ALL relative time expressions MUST be converted to absolute dates using the session date:
- "yesterday" → calculate from session date
- "last weekend" → calculate from session date
- "about 10 years ago" → calculate the approximate year
If you cannot determine the exact date, include your best estimate and mark it with "approximately".
NEVER leave a relative time expression as-is.

## MANDATORY: eventDate field
The "eventDate" field is REQUIRED for every item. Use YYYY-MM-DD format.
- If the fact has a specific date, use it
- If only a month is known, use the first of that month (e.g., "2022-04-01")
- If only a year is known, use January 1 (e.g., "2022-01-01")
- If no date can be inferred, use the session date as default
NEVER leave eventDate empty or null."""

EXTRACT_USER_TEMPLATE = """Conversation date/time: {datetime}
Participants: {speaker_a} and {speaker_b}

Conversation:
{transcript}

Extract EVERY distinct fact from this conversation as a separate memory item. Do NOT group by topic — each fact gets its own item.
There is NO limit on the number of items. Extract as many as needed.

Return a JSON array where each item has:
- "name": short descriptive title WITH date (e.g., "James adopted a puppy named Ned in April 2022")
- "description": one-sentence summary with key details — be SPECIFIC and SEARCHABLE
- "content": full description with all specifics (who, what, when, where)
- "tags": array of relevant tags (people names, topics, exact dates in YYYY-MM-DD format)
- "eventDate": REQUIRED — YYYY-MM-DD format date when this event/fact occurred. Use session date if no specific date.

CRITICAL rules:
1. Each item = ONE fact. Do NOT combine multiple facts.
2. If a list is mentioned (games, tricks, countries, books), ALL items must be in one entry.
3. ALL dates must be absolute (YYYY-MM-DD). Convert relative dates using the session date.
4. The "name" and "description" will be used to match future queries — make them specific and searchable."""


def extract_memories_from_session(
    transcript: str,
    datetime_str: str,
    speaker_a: str,
    speaker_b: str,
    cfg: Optional[dict] = None,
) -> list:
    """
    Use LLM to extract individual fact items from a conversation session.
    Two-pass extraction:
      Pass 1: extract from all chunks
      Pass 2: find uncovered segments, re-extract from them
    Returns a list of dicts with name, description, content, tags, eventDate.
    """
    if cfg is None:
        cfg = _get_config()

    MAX_CHUNK = 8000

    if len(transcript) <= MAX_CHUNK:
        # Single chunk: extract twice, merge
        facts1 = _extract_single_chunk(transcript, datetime_str, speaker_a, speaker_b, cfg)
        uncovered = _find_uncovered_segments(transcript, facts1)
        if uncovered and len(uncovered) > 300:
            facts2 = _extract_single_chunk(uncovered, datetime_str, speaker_a, speaker_b, cfg,
                                           chunk_hint="(补充提取) ")
            facts1.extend(facts2)
        return _deduplicate_facts(facts1)

    # Split long transcripts by turn boundaries
    chunks = _split_transcript_into_chunks(transcript, MAX_CHUNK)
    all_facts = []
    for i, chunk in enumerate(chunks):
        chunk_hint = f"(Part {i+1}/{len(chunks)}) " if len(chunks) > 1 else ""
        facts = _extract_single_chunk(
            chunk, datetime_str, speaker_a, speaker_b, cfg, chunk_hint=chunk_hint
        )
        all_facts.extend(facts)

    # Pass 2: find uncovered segments from the full transcript
    uncovered = _find_uncovered_segments(transcript, all_facts)
    if uncovered and len(uncovered) > 500:
        logger.info(f"    Pass 2: re-extracting from {len(uncovered)} uncovered chars")
        extra_facts = _extract_single_chunk(
            uncovered[:10000], datetime_str, speaker_a, speaker_b, cfg,
            chunk_hint="(补充提取) "
        )
        all_facts.extend(extra_facts)

    # Deduplicate by name similarity
    return _deduplicate_facts(all_facts)


def _find_uncovered_segments(transcript: str, facts: list, min_segment_len: int = 200) -> str:
    """
    Find transcript segments that are NOT covered by any extracted fact.
    Uses keyword matching: if a sentence's key terms don't appear in any fact,
    it's considered uncovered.
    Returns the uncovered text concatenated.
    """
    if not facts:
        return transcript

    # Build a set of all keywords from extracted facts
    fact_keywords = set()
    for f in facts:
        for field in (f.get("name", ""), f.get("description", ""), f.get("content", "")):
            # Extract words > 3 chars as keywords
            for word in re.findall(r'\b\w{4,}\b', field.lower()):
                fact_keywords.add(word)

    # Split transcript into sentences/speaker turns
    lines = transcript.split('\n')
    uncovered_lines = []

    for line in lines:
        if len(line.strip()) < 20:
            continue
        # Check if this line has keywords matching extracted facts
        line_words = set(re.findall(r'\b\w{4,}\b', line.lower()))
        # If fewer than 20% of the line's keywords are in fact_keywords, it's uncovered
        if not line_words:
            continue
        overlap = len(line_words & fact_keywords)
        overlap_ratio = overlap / len(line_words) if line_words else 0
        if overlap_ratio < 0.2:
            uncovered_lines.append(line)

    uncovered_text = '\n'.join(uncovered_lines)
    return uncovered_text if len(uncovered_text) >= min_segment_len else ""


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
                if union > 0 and overlap / union > 0.7:
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
        transcript=transcript[:10000],
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
        "max_tokens": 12288,
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
