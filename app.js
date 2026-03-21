const express = require('express');
const app = express();
const { engine } = require('express-handlebars');
const bodyParser = require('body-parser');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const Usuario = require('./models/Usuario');


// configuração para receber dados de formulários
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const uploadsDir = path.join(__dirname, 'uploads', 'users');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (_req, _file, cb) => {
        cb(null, uploadsDir);
    },
    filename: (_req, file, cb) => {
        const tempName = `temp_${Date.now()}_${Math.round(Math.random() * 1e9)}${path.extname(file.originalname || '.jpg')}`;
        cb(null, tempName);
    }
});

const upload = multer({ storage });

function formatTimestampForFile(dateValue) {
    const date = new Date(dateValue);
    const pad = (n) => String(n).padStart(2, '0');

    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

async function optimizeImageTo1MB(inputPath, outputPath) {
    const maxBytes = 1048576; // 1MB
    let quality = 90;
    let buffer;

    while (quality >= 30) {
        buffer = await sharp(inputPath)
            .resize(200, 200, {
                fit: 'cover',
                position: 'center'
            })
            .jpeg({ quality, progressive: true })
            .toBuffer();

        if (buffer.length <= maxBytes) {
            break;
        }
        quality -= 5;
    }

    await fs.promises.writeFile(outputPath, buffer);
    return buffer.length;
}


// rota principal
app.get('/', (req, res) => {
    res.render('index');
});


// ALUNOS
app.get('/aluno', function(req, res) {
    Usuario.findAll({
        where: { active: true },
        order: [['first_name', 'ASC']]
    }).then(function(usuarios) {
        const lista = usuarios.map((u) => u.get({ plain: true }));
        res.render('aluno', {
            mensagem: req.query.mensagem || '',
            usuarios: lista
        });
    }).catch(function(err) {
        res.render('aluno', {
            mensagem: 'Erro ao carregar alunos: ' + err.message,
            usuarios: []
        });
    });
});

app.get('/aluno/novo', (req, res) => {
    res.render('formnovoaluno');
});

app.post('/aluno/cadastrar', upload.single('photo'), async (req, res) => {
    try {
        const usuario = await Usuario.create({
            first_name: req.body.first_name,
            last_name: req.body.last_name,
            email: req.body.email,
            password: req.body.password2,
            role: 'STD',
            phone: req.body.phone,
            birth_date: req.body.birth_date,
            actual_belt: req.body.actual_belt,
            actual_degree: req.body.actual_degree,
            wagi_size: req.body.wagi_size,
            zubon_size: req.body.zubon_size,
            obi_size: req.body.obi_size
        });

        if (req.file) {
            const timestamp = formatTimestampForFile(usuario.createdAt || new Date());
            const finalFileName = `${usuario.id}_${timestamp}.jpg`;
            const currentFilePath = path.join(uploadsDir, req.file.filename);
            const finalFilePath = path.join(uploadsDir, finalFileName);

            try {
                const fileSize = await optimizeImageTo1MB(currentFilePath, finalFilePath);
                console.log(`Imagem salva: ${finalFileName} (${(fileSize / 1024).toFixed(2)}KB)`);
                
                // Remove arquivo temporÃ¡rio se for diferente
                if (currentFilePath !== finalFilePath && fs.existsSync(currentFilePath)) {
                    await fs.promises.unlink(currentFilePath);
                }
            } catch (imageErr) {
                console.error('Erro ao otimizar imagem:', imageErr);
                if (fs.existsSync(currentFilePath)) {
                    await fs.promises.unlink(currentFilePath);
                }
                throw new Error('Erro ao processar imagem: ' + imageErr.message);
            }

            usuario.photo = `/uploads/users/${finalFileName}`;
            await usuario.save();
        }

        const mensagem = 'Aluno criado com sucesso.';
        res.redirect(`/aluno?mensagem=${encodeURIComponent(mensagem)}`);
    } catch (err) {
        console.error('Erro no cadastro:', err);
        const mensagem = 'Erro ao criar aluno: ' + err.message;
        res.redirect(`/aluno?mensagem=${encodeURIComponent(mensagem)}`);
    }
});
app.get('/aluno/editar/:id', (req, res) => {
    // const alunoId = req.params.id;
    // res.render('formeditaraluno', { id: alunoId });
    return res.status(501).send('Rota de edição ainda não implementada.');
});


// solicitaÃ§Ã£o de presenÃ§a
app.get('/presenca', function(req, res) {
    res.render('presenca');
});


// login
app.get('/login', function(req, res) {
    res.render('login');
});


// ### CONFIGURAÃ‡Ã•ES GERAIS ### 
// engine de template de visualizaÃ§Ã£o
app.engine('handlebars', engine({ defaultLayout: 'main' }));
app.set('view engine', 'handlebars');


// execuÃ§Ã£o do servidor
app.listen(8080, function() {
    console.clear();
    console.log('Servidor funcionando...');
    console.log('Acesse http://localhost:8080 para ver o app.');
});


