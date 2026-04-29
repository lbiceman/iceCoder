"""Quick offline verification of the new matching logic against saved results."""
import json, re, sys

def _entity_found(entity, text_lower, synonyms_map):
    entity_lower = entity.strip().lower()
    if entity_lower in text_lower:
        return True
    synonym_list = synonyms_map.get(entity.strip(), [])
    for syn in synonym_list:
        syn_lower = syn.lower()
        if any(c in syn for c in [".*", ".+", "\\", "^", "$", "[", "]"]):
            try:
                if re.search(syn_lower, text_lower):
                    return True
            except re.error:
                if syn_lower in text_lower:
                    return True
        else:
            if syn_lower in text_lower:
                return True
    return False

def check_multi_hop(recalled_text, answer, sample):
    entities = [e.strip() for e in answer.split(",") if e.strip()]
    synonyms_map = sample.get("answer_synonyms", {})
    recalled_lower = recalled_text.lower()
    for entity in entities:
        found = _entity_found(entity, recalled_lower, synonyms_map)
        print(f"  Entity '{entity}': {'FOUND' if found else 'NOT FOUND'}")
    return all(_entity_found(e, recalled_lower, synonyms_map) for e in entities)

# Load saved result for locomo-9
with open("LoCoMo/result.json", "r", encoding="utf-8") as f:
    data = json.load(f)

for detail in data["details"]:
    if detail["id"] == "locomo-9":
        combined = detail["recalled_text"] + "\n" + detail["response"]
        sample = {
            "answer_synonyms": {
                "avoid conflicts": ["避免冲突", "避开冲突", "避免端口冲突", "避开端口冲突", "port conflict", "避免.*冲突", "避开.*PostgreSQL"]
            }
        }
        print(f"Testing locomo-9:")
        result = check_multi_hop(combined, "5433,avoid conflicts", sample)
        print(f"  Result: {'PASS' if result else 'FAIL'}")
        break
