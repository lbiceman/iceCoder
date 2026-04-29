import requests
try:
    r = requests.get('http://127.0.0.1:3000/api/memory/stats', timeout=5)
    print('Status:', r.status_code)
    print('Body:', r.text[:300])
except Exception as e:
    print('Error:', type(e).__name__, str(e))
