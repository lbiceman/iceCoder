"""Print full reasoning_content to see where the JSON is."""
import requests
import json

cfg = {
    "api_key": "tp-cf2ficw7uniopfaylalh3ghrdrvqmdmh1khni959gaykw66h",
    "base_url": "https://token-plan-cn.xiaomimimo.com/v1",
    "model": "mimo-v2.5-pro",
}
url = cfg["base_url"].rstrip("/") + "/chat/completions"
headers = {"Authorization": f"Bearer {cfg['api_key']}", "Content-Type": "application/json"}
payload = {
    "model": cfg["model"],
    "messages": [
        {"role": "system", "content": "You are an expert evaluator. Return ONLY a JSON object, no other text."},
        {"role": "user", "content": 'Question: When did Caroline go to the LGBTQ support group?\nExpected Answer: 7 May 2023\nModel Response: Caroline went to the LGBTQ support group on 7 May 2023.\n\nJudge whether the model\'s response is semantically consistent with the expected answer.\nReturn a JSON object with exactly these fields:\n- "verdict": "correct" or "incorrect"\n- "confidence": a float between 0.0 and 1.0\n- "reason": a brief explanation (one sentence)'},
    ],
    "temperature": 0.1,
    "max_tokens": 256,
}
resp = requests.post(url, headers=headers, json=payload, timeout=30)
data = resp.json()
msg = data["choices"][0]["message"]
print("=== content ===")
print(repr(msg.get("content", "")))
print()
print("=== reasoning_content (full) ===")
print(msg.get("reasoning_content", "NONE"))
print()
print("=== finish_reason ===")
print(data["choices"][0].get("finish_reason", "NONE"))
