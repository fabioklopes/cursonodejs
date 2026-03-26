import os

pasta = r"D:\\Aulas\\teste-node\\public\\img\\belts"

for nome in os.listdir(pasta):
    caminho_antigo = os.path.join(pasta, nome)

    if os.path.isdir(caminho_antigo):
        continue

    novo_nome = nome.lower()

    if nome != novo_nome:
        temp = os.path.join(pasta, f"__temp__{novo_nome}")
        caminho_novo = os.path.join(pasta, novo_nome)

        os.rename(caminho_antigo, temp)
        os.rename(temp, caminho_novo)

        print(f"Renomeado: {nome} -> {novo_nome}")


for nome in os.listdir(pasta):
    if nome.endswith("_degrees.png"):
        novo_nome = nome.replace("_degrees", "")
        caminho_antigo = os.path.join(pasta, nome)
        caminho_novo = os.path.join(pasta, novo_nome)
        os.rename(caminho_antigo, caminho_novo)
        print(f"Renomeado: {nome} -> {novo_nome}")
