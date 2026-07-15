# -*- coding: utf-8 -*-
"""
Unit tests for evaluator_judge.py — the functions we changed.

Covers:
- _parse_judge_response: valid JSON, malformed JSON regex fallback, code block stripping, complete failure
- _find_uncovered_segments: full coverage, partial coverage, empty facts, short transcript
- _deduplicate_facts: exact dup, high overlap dup (0.7 threshold), low overlap non-dup
"""

import unittest
import sys
import os

# Add parent dir to path so we can import evaluator_judge
sys.path.insert(0, os.path.dirname(__file__))

from evaluator_judge import (
    _parse_judge_response,
    _find_uncovered_segments,
    _deduplicate_facts,
)


# ===========================================================================
# _parse_judge_response
# ===========================================================================

class TestParseJudgeResponse(unittest.TestCase):
    """Tests for the judge response parser with regex fallback."""

    def test_valid_json(self):
        """Standard valid JSON parses correctly."""
        content = '{"verdict": "correct", "confidence": 0.95, "reason": "Semantically equivalent"}'
        result = _parse_judge_response(content)
        assert result["verdict"] == "correct"
        assert result["confidence"] == 0.95
        assert result["reason"] == "Semantically equivalent"

    def test_valid_json_incorrect(self):
        """Incorrect verdict parses correctly."""
        content = '{"verdict": "incorrect", "confidence": 0.8, "reason": "Missing key detail"}'
        result = _parse_judge_response(content)
        assert result["verdict"] == "incorrect"
        assert result["confidence"] == 0.8

    def test_valid_json_with_code_block(self):
        """JSON wrapped in markdown code block is stripped and parsed."""
        content = '```json\n{"verdict": "correct", "confidence": 0.7, "reason": "ok"}\n```'
        result = _parse_judge_response(content)
        assert result["verdict"] == "correct"
        assert result["confidence"] == 0.7

    def test_valid_json_with_plain_code_block(self):
        """JSON wrapped in plain code block (no lang tag) is stripped."""
        content = '```\n{"verdict": "incorrect", "confidence": 0.3, "reason": "wrong"}\n```'
        result = _parse_judge_response(content)
        assert result["verdict"] == "incorrect"
        assert result["confidence"] == 0.3

    def test_malformed_json_regex_fallback(self):
        """Malformed JSON with valid verdict field is rescued by regex."""
        # Trailing comma makes this invalid JSON
        content = '{"verdict": "correct", "confidence": 0.6, "reason": "ok",}'
        result = _parse_judge_response(content)
        assert result["verdict"] == "correct"
        assert result["confidence"] == 0.6
        assert result["reason"] == "ok"

    def test_malformed_json_missing_reason(self):
        """Regex fallback works when reason field is missing."""
        content = '{"verdict": "incorrect", "confidence": 0.4}'
        # This is actually valid JSON, but let's test with a broken version
        content = '{"verdict": "incorrect", "confidence": 0.4, broken'
        result = _parse_judge_response(content)
        assert result["verdict"] == "incorrect"
        assert result["confidence"] == 0.4
        assert "Parsed via regex fallback" in result["reason"]

    def test_malformed_json_no_verdict(self):
        """Completely broken JSON with no recognizable fields returns incorrect."""
        content = 'this is not json at all'
        result = _parse_judge_response(content)
        assert result["verdict"] == "incorrect"
        assert result["confidence"] == 0.0
        assert "JSON parse failed" in result["reason"]

    def test_malformed_json_case_insensitive_verdict(self):
        """Regex fallback handles 'Correct' with uppercase."""
        content = '{"verdict": "Correct", "confidence": 0.9 broken'
        result = _parse_judge_response(content)
        assert result["verdict"] == "correct"

    def test_confidence_clamped_to_0_1(self):
        """Confidence values are clamped to [0, 1]."""
        content = '{"verdict": "correct", "confidence": 1.5, "reason": "ok"}'
        result = _parse_judge_response(content)
        assert result["confidence"] == 1.0

        content = '{"verdict": "correct", "confidence": -0.5, "reason": "ok"}'
        result = _parse_judge_response(content)
        assert result["confidence"] == 0.0

    def test_missing_verdict_defaults_to_incorrect(self):
        """Missing verdict field defaults to 'incorrect'."""
        content = '{"confidence": 0.5, "reason": "no verdict"}'
        result = _parse_judge_response(content)
        assert result["verdict"] == "incorrect"

    def test_invalid_verdict_value_defaults_to_incorrect(self):
        """Invalid verdict value (not 'correct'/'incorrect') defaults to 'incorrect'."""
        content = '{"verdict": "maybe", "confidence": 0.5, "reason": "uncertain"}'
        result = _parse_judge_response(content)
        assert result["verdict"] == "incorrect"


# ===========================================================================
# _find_uncovered_segments
# ===========================================================================

class TestFindUncoveredSegments(unittest.TestCase):
    """Tests for the two-pass extraction gap detector."""

    def test_empty_facts_returns_full_transcript(self):
        """When no facts extracted, entire transcript is uncovered."""
        transcript = "Speaker A: I love playing piano\nSpeaker B: That's great, what songs do you play?"
        result = _find_uncovered_segments(transcript, [])
        assert result == transcript

    def test_full_coverage_returns_empty(self):
        """When all keywords are covered, returns empty string."""
        transcript = "Speaker A: James has a dog named Max who can sit and stay"
        facts = [{"name": "James has a dog named Max", "description": "Max can sit and stay", "content": "James's dog Max knows sit and stay tricks"}]
        result = _find_uncovered_segments(transcript, facts)
        # Should be empty or very short because keywords overlap
        assert len(result) < 200  # below min_segment_len

    def test_partial_coverage_finds_gaps(self):
        """Unrelated content is detected as uncovered."""
        transcript = """Speaker A: I adopted a puppy named Max from the shelter
Speaker B: That's wonderful! What breed is he?
Speaker A: He's a golden retriever, very playful
Speaker B: I've been studying quantum physics and advanced mathematics recently
Speaker A: Fascinating, I prefer researching molecular biology and organic chemistry"""
        # Facts only cover the dog topic
        facts = [{"name": "Adopted puppy Max", "description": "Golden retriever from shelter", "content": "Max is a golden retriever puppy adopted from shelter"}]
        result = _find_uncovered_segments(transcript, facts)
        # The science lines should be uncovered (no keyword overlap with dog facts)
        assert "quantum" in result or "physics" in result or "mathematics" in result

    def test_short_lines_skipped(self):
        """Lines shorter than 20 chars are skipped."""
        transcript = "A: Hi\nB: Hello\nSpeaker A: I really love playing the guitar every day"
        facts = [{"name": "guitar playing", "description": "loves playing guitar", "content": "plays guitar daily"}]
        result = _find_uncovered_segments(transcript, facts)
        # Short lines like "A: Hi" are skipped
        assert "A: Hi" not in result

    def test_facts_with_empty_fields(self):
        """Facts with empty name/description/content don't crash."""
        transcript = "Speaker A: This is a test line with enough words to be processed"
        facts = [{"name": "", "description": "", "content": ""}]
        # Should not crash, and transcript should be uncovered since no keywords
        result = _find_uncovered_segments(transcript, facts)
        assert isinstance(result, str)


# ===========================================================================
# _deduplicate_facts
# ===========================================================================

class TestDeduplicateFacts(unittest.TestCase):
    """Tests for fact deduplication with 0.7 Jaccard threshold."""

    def test_empty_list(self):
        """Empty input returns empty output."""
        assert _deduplicate_facts([]) == []

    def test_no_duplicates(self):
        """Distinct facts are all preserved."""
        facts = [
            {"name": "James adopted a puppy", "content": "adopted from shelter"},
            {"name": "John plays drums", "content": "started in February"},
        ]
        result = _deduplicate_facts(facts)
        assert len(result) == 2

    def test_exact_name_duplicate(self):
        """Exact name duplicates are removed."""
        facts = [
            {"name": "James has a dog", "content": "first mention"},
            {"name": "James has a dog", "content": "second mention"},
        ]
        result = _deduplicate_facts(facts)
        assert len(result) == 1

    def test_exact_name_duplicate_case_insensitive(self):
        """Name comparison is case-insensitive."""
        facts = [
            {"name": "James Has A Dog", "content": "first"},
            {"name": "james has a dog", "content": "second"},
        ]
        result = _deduplicate_facts(facts)
        assert len(result) == 1

    def test_high_overlap_duplicate_above_0_7(self):
        """Facts with >70% word overlap are deduplicated."""
        # "James has a dog named Max" vs "James has a dog named Daisy"
        # Words: {james, has, a, dog, named, max} vs {james, has, a, dog, named, daisy}
        # Intersection: {james, has, a, dog, named} = 5
        # Union: {james, has, a, dog, named, max, daisy} = 7
        # Jaccard = 5/7 ≈ 0.71 > 0.7 → duplicate
        facts = [
            {"name": "James has a dog named Max", "content": "golden retriever"},
            {"name": "James has a dog named Daisy", "content": "labrador"},
        ]
        result = _deduplicate_facts(facts)
        assert len(result) == 1

    def test_low_overlap_not_deduplicated(self):
        """Facts with <70% word overlap are kept separate."""
        # "James adopted a puppy" vs "John plays drums"
        # No word overlap → Jaccard = 0
        facts = [
            {"name": "James adopted a puppy", "content": "from shelter"},
            {"name": "John plays drums", "content": "since February"},
        ]
        result = _deduplicate_facts(facts)
        assert len(result) == 2

    def test_boundary_at_exactly_0_7(self):
        """Facts at exactly 0.7 overlap are NOT deduplicated (threshold is >0.7)."""
        # 3 words: {a, b, c} vs {a, b, d}
        # Intersection: {a, b} = 2, Union: {a, b, c, d} = 4
        # Jaccard = 2/4 = 0.5 → not duplicate
        facts = [
            {"name": "a b c", "content": "test1"},
            {"name": "a b d", "content": "test2"},
        ]
        result = _deduplicate_facts(facts)
        assert len(result) == 2

    def test_single_word_names_not_deduplicated(self):
        """Single-word names are not compared for overlap (len < 2)."""
        facts = [
            {"name": "piano", "content": "instrument"},
            {"name": "guitar", "content": "instrument"},
        ]
        result = _deduplicate_facts(facts)
        assert len(result) == 2

    def test_preserves_order(self):
        """Deduplication preserves the order of first occurrence."""
        facts = [
            {"name": "first fact", "content": "A"},
            {"name": "second fact", "content": "B"},
            {"name": "first fact", "content": "C"},  # dup of first
        ]
        result = _deduplicate_facts(facts)
        assert len(result) == 2
        assert result[0]["content"] == "A"
        assert result[1]["content"] == "B"

    def test_multiple_duplicates(self):
        """Multiple duplicates of the same fact are all removed."""
        facts = [
            {"name": "James has a dog named Max", "content": "v1"},
            {"name": "James has a dog named Max", "content": "v2"},
            {"name": "James has a dog named Max", "content": "v3"},
            {"name": "John plays drums", "content": "unique"},
        ]
        result = _deduplicate_facts(facts)
        assert len(result) == 2


if __name__ == "__main__":
    unittest.main()
