function generateCode(tamanho = 5) {
	const letras = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // removido "i" e "o"
	const numeros = "123456789"; // removido "0"
	const caracteres = letras + numeros;

	let codigo = "";

	for (let i = 0; i < tamanho; i++) {
		const index = Math.floor(Math.random() * caracteres.length);
		codigo += caracteres[index];
	}

	return codigo.toUpperCase();
}

module.exports = generateCode;