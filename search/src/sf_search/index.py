import torch
from .unixcoder_embeddings import UniXcoderEmbeddings

embedding_provider = UniXcoderEmbeddings()

def create_index(code_objs):
    result = []

    for code_obj in code_objs:
        embedding = embedding_provider.get_embedding([code_obj['code']])

        embedding_obj = {
            **code_obj,
            'embedding': embedding.tolist(),
        }
        del embedding_obj['code']
        result.append(embedding_obj)

    return result

def search_index(index, query, limit=5, threshold=0.3):
    query_embedding = embedding_provider.get_embedding([query])
    result = []

    for embedding_obj in index:
        if len(result) > limit:
            break

        similarity = embedding_provider.similarity(query_embedding, torch.tensor(embedding_obj['embedding']))

        if similarity > threshold:
            result_obj = {
                **embedding_obj,
                'score': similarity
            }
            del result_obj['embedding']
            result.append(result_obj)

    result.sort(key=lambda x: x['score'], reverse=True)
    return result
