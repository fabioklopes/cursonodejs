const express = require('express');
const app = express();


// rota principal
app.get('/', function(req, res) {
    res.send('Olá Mundo!')
});


// cadastro de alunos
app.get('/aluno', function(req, res) {
    res.send('Rota de cadastro de alunos');
});


// solicitação de presença
app.get('/presenca', function(req, res) {
    res.send('Rota de solicitação de presença');
});


// login
app.get('/login', function(req, res) {
    res.send('Rota de login');
});


// execução da aplicação
app.listen(8080, function() {
    console.clear();
    console.log('-----------------------');
    console.log('Servidor funcionando...');
    console.log('Acesse http://localhost:8080 para ver o app');
});
