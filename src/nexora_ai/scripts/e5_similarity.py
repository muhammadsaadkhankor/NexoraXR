# Cross-lingual semantic similarity for translation quality control.
# Reads {"pairs": [[source_text, candidate_text], ...]} from stdin and prints
# a JSON array of cosine similarities to stdout. Model: intfloat/
# multilingual-e5-small (query:/passage: prefixes required by the model).
# Run with the conda env that has transformers+torch (e.g. tts env).
import sys, json, warnings

warnings.filterwarnings('ignore')

import torch
import torch.nn.functional as F
from transformers import AutoTokenizer, AutoModel

MODEL = 'intfloat/multilingual-e5-small'


def main():
    payload = json.load(sys.stdin)
    pairs = payload['pairs']
    tok = AutoTokenizer.from_pretrained(MODEL)
    model = AutoModel.from_pretrained(MODEL)
    model.eval()

    def embed(texts, prefix):
        enc = tok([prefix + t for t in texts], return_tensors='pt',
                  padding=True, truncation=True, max_length=512)
        with torch.no_grad():
            hidden = model(**enc).last_hidden_state
        mask = enc['attention_mask'].unsqueeze(-1)
        pooled = (hidden * mask).sum(1) / mask.sum(1).clamp(min=1)
        return F.normalize(pooled, dim=1)

    srcs = [p[0] for p in pairs]
    tgts = [p[1] for p in pairs]
    e_src = embed(srcs, 'query: ')
    e_tgt = embed(tgts, 'passage: ')
    scores = (e_src * e_tgt).sum(1).tolist()
    print(json.dumps(scores))


if __name__ == '__main__':
    main()
