import torch
from torch.nn.functional import normalize
from .unixcoder import UniXcoder

class UniXcoderEmbeddings:
    def __init__(self, model_name="microsoft/unixcoder-base"):
        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        self.model = UniXcoder(model_name).to(self.device)

    def get_embedding(self, text):
        tokens_ids = self.model.tokenize(text, max_length=512, mode="<encoder-only>")
        source_ids = torch.tensor(tokens_ids).to(self.device)
        _, embedding = self.model(source_ids)
        return embedding

    def similarity(self, nl_embedding, code_embedding):
        norm_code_embedding = normalize(code_embedding, p=2, dim=1)
        norm_nl_embedding = normalize(nl_embedding, p=2, dim=1)
        similarity = torch.einsum("ac,bc->ab", norm_nl_embedding, norm_code_embedding)
        return similarity.item()
