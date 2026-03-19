const express = require('express');
const path = require('path');
const { engine } = require('express-handlebars');
const app = express();


// engine de template
app.engine('handlebars', engine({
    defaultLayout: 'main',
    layoutsDir: path.join(__dirname, 'views', 'layouts')
}));


// rota principal
app.get('/', (req, res) => {
    res.render('index', {
        title: 'Gerenciador de Presenças',
    });
});


// cadastro de alunos
app.get('/aluno', function(req, res) {
    res.sendFile(path.join(__dirname, 'views', 'aluno.html'));
});


// solicitação de presença
app.get('/presenca', function(req, res) {
    res.sendFile(path.join(__dirname, 'views', 'presenca.html'));
});


// login
app.get('/login', function(req, res) {
    res.sendFile(path.join(__dirname, 'views', 'login.html'));
});


// configurações de template execução da aplicação
app.set('view engine', 'handlebars');
app.set('views', path.join(__dirname, 'views'));

app.listen(8080, function() {
    console.clear();
    console.log('Servidor funcionando...');
    console.log('Acesse http://localhost:8080 para ver o app.');
});
