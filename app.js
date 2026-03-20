const express = require('express');
const app = express();
const { engine } = require('express-handlebars');
const Sequelize = require('sequelize');


// conexão com o banco de dados
const sequelize = new Sequelize('db_academia_v2', 'root', '5tgb6yhn', {
    host: '127.0.0.1',
    dialect: 'mysql'
});


// rota principal
app.get('/', (req, res) => {
    res.render('index');
});


// ALUNOS
app.get('/aluno', function(req, res) {
    res.render('aluno');
});
app.get('/aluno/novo', (req, res) => {
    res.render('formnovoaluno');
});
app.post('/aluno/cadastrar', (req, res) => {
    res.send('Formulário recebido');
});
app.get('/aluno/editar/:id', (req, res) => {
    // const alunoId = req.params.id;
    // res.render('formeditaraluno', { id: alunoId });
    pass
});


// solicitação de presença
app.get('/presenca', function(req, res) {
    res.render('presenca');
});


// login
app.get('/login', function(req, res) {
    res.render('login');
});


// ### CONFIGURAÇÕES GERAIS ### 
// engine de template de visualização
app.engine('handlebars', engine({ defaultLayout: 'main' }));
app.set('view engine', 'handlebars');


app.listen(8080, function() {
    console.clear();
    console.log('Servidor funcionando...');
    console.log('Acesse http://localhost:8080 para ver o app.');
});
