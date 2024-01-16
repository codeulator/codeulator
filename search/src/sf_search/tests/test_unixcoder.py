from ..unixcoder_embeddings import UniXcoderEmbeddings

provider = UniXcoderEmbeddings()

# Encode maximum function
max_func = "def f(a,b): if a>b: return a else return b"
max_func_embedding = provider.get_embedding([max_func])

# Encode minimum function
min_func = "def f(a,b): if a<b: return a else return b"
min_func_embedding = provider.get_embedding([min_func])

# Encode natural language
nl = "return maximum value"
nl_embedding = provider.get_embedding([nl])

# Calculate cosine similarity between NL and two functions
max_func_nl_similarity = provider.similarity(nl_embedding, max_func_embedding)
min_func_nl_similarity = provider.similarity(nl_embedding, min_func_embedding)

print(max_func_nl_similarity)
print(min_func_nl_similarity)
