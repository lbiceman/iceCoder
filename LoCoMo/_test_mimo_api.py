"""Quick test to see MiMo API response structure."""
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
        {"role": "system", "content": "Return ONLY a JSON object, no other text."},
        {"role": "user", "content": 'Question: When did Caroline go to the LGBTQ support group?\nExpected Answer: 7 May 2023\nModel Response: Caroline went to the LGBTQ support group on 7 May 2023.\n\nReturn JSON: {"verdict": "correct" or "incorrect", "confidence": float, "reason": str}'},
    ],
    "temperature": 0.1,
    "max_tokens": 256,
}
resp = requests.post(url, headers=headers, json=payload, timeout=30)
print("Status:", resp.status_code)
data = resp.json()
msg = data["choices"][0]["message"]
print("Keys:", list(msg.keys()))
print("content repr:", repr(msg.get("content", "")))
print("reasoning_content repr:", repr(msg.get("reasoning_content", "NOT_PRESENT")))
print()
print("Full message:", json.dumps(msg, indent=2, ensure_ascii=False))
