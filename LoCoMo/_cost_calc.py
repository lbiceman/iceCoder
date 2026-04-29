import json

d = json.load(open("LoCoMo/locomo10.json", encoding="utf-8"))

total_conv_chars = 0
total_qa = 0

for s in d:
    conv = s["conversation"]
    sess_keys = [k for k in conv if k.startswith("session_") and not k.endswith("_date_time")]
    chars = 0
    turns = 0
    for sk in sess_keys:
        for t in conv[sk]:
            chars += len(t.get("text", ""))
            turns += 1
    qa_count = len(s["qa"])
    total_conv_chars += chars
    total_qa += qa_count
    print(f"  {s['sample_id']}: {len(sess_keys)} sess, {turns} turns, {chars:,} chars, {qa_count} QA")

print(f"\nTOTAL: {total_conv_chars:,} chars conversation, {total_qa} QA")
mem_tokens = total_conv_chars // 3  # ~3 chars per token for English
print(f"Estimated memory file size: ~{mem_tokens:,} tokens")

# System prompt
sp = open("data/system-prompt.md", encoding="utf-8").read()
sp_tokens = len(sp) // 3
print(f"System prompt: ~{sp_tokens:,} tokens")

# Tool definitions: ~28 tools, ~200 tokens each
tool_tokens = 28 * 200
print(f"Tool definitions: ~{tool_tokens:,} tokens")

# Per QA call estimate
# Memory recall: max 10 files, each session ~500-2000 tokens
# Average recalled memory per query: ~5 files * 1000 tokens = 5000 tokens
recall_tokens = 5000
base_input = sp_tokens + tool_tokens + recall_tokens + 100  # +100 for question
print(f"\nPer QA input estimate: {base_input:,} tokens")
print(f"  system prompt: {sp_tokens:,}")
print(f"  tools: {tool_tokens:,}")
print(f"  memory recall: {recall_tokens:,}")
print(f"  question: ~100")

# But context accumulates! After compaction threshold (80K tokens or 40 messages)
# it compacts, keeping recent 10 messages
# So average context size oscillates between ~15K and ~80K
# Let's estimate average at ~30K per call
avg_input = 30000
avg_output = 300  # typical response

print(f"\nAverage per QA (with context accumulation): ~{avg_input:,} input, ~{avg_output} output")

# Memory extraction: triggered every 3 turns
# Each extraction: ~5K input, ~500 output
extract_calls = total_qa // 3
extract_input = 5000
extract_output = 500

print(f"\nMemory extraction calls: ~{extract_calls}")

# Total tokens
total_input = (total_qa * avg_input) + (extract_calls * extract_input)
total_output = (total_qa * avg_output) + (extract_calls * extract_output)

# Judge tokens
judge_input = total_qa * 400
judge_output = total_qa * 60

total_input += judge_input
total_output += judge_output

print(f"\n{'='*50}")
print(f"COST ESTIMATE (DeepSeek V4 Flash)")
print(f"{'='*50}")
print(f"  QA Harness:     {total_qa} calls × ~{avg_input:,} in + ~{avg_output} out")
print(f"  Mem extraction: {extract_calls} calls × ~{extract_input:,} in + ~{extract_output} out")
print(f"  Judge:          {total_qa} calls × ~400 in + ~60 out")
print(f"{'─'*50}")
print(f"  Total input:    ~{total_input/1_000_000:.1f}M tokens")
print(f"  Total output:   ~{total_output/1_000_000:.1f}M tokens")
print(f"{'─'*50}")

# DeepSeek V4 Flash pricing (per M tokens)
price_in = 0.14  # CNY per M input tokens
price_out = 0.28  # CNY per M output tokens

cost_in = (total_input / 1_000_000) * price_in
cost_out = (total_output / 1_000_000) * price_out
cost_total = cost_in + cost_out

print(f"  Input cost:     ¥{cost_in:.2f}")
print(f"  Output cost:    ¥{cost_out:.2f}")
print(f"  TOTAL:          ¥{cost_total:.2f}")
print(f"{'='*50}")
