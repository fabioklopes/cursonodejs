const express = require('express');
const app = express();


// rota principal
app.get('/', function(req, res) {
    res.sendFile(__dirname + '/html/index.html');
});


// cadastro de alunos
app.get('/aluno', function(req, res) {
    res.sendFile(__dirname + '/html/aluno.html');
});


// solicitação de presença
app.get('/presenca', function(req, res) {
    res.sendFile(__dirname + '/html/presenca.html');
});


// login
app.get('/login', function(req, res) {
    res.sendFile(__dirname + '/html/login.html');
});


// execução da aplicação
app.listen(8080, function() {
    console.clear();
    console.log('Servidor funcionando...');
    console.log('Acesse http://localhost:8080 para ver o app.');
});
