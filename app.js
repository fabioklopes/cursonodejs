const express = require('express');
const app = express();
const { engine } = require('express-handlebars');
const bodyParser = require('body-parser');
const session = require('express-session');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const argon2 = require('argon2');
const Usuario = require('./models/Usuario');


// configuração gerais da aplicação / momento de execução
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static('public'));
app.use(session({
    name: 'oss.sid',
    secret: process.env.SESSION_SECRET || 'oss_session_secret_dev',
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 1000 * 60 * 60 * 8
    }
}));

app.use((req, res, next) => {
    res.locals.usuarioLogado = req.session.usuario || null;
    next();
});

function isPublicRoute(pathname) {
    return pathname === '/auth/login'
        || pathname === '/auth/verify'
        || pathname === '/aluno/novo'
        || pathname === '/aluno/cadastrar'
        || pathname.startsWith('/uploads/');
}

function requireAuth(req, res, next) {
    if (isPublicRoute(req.path)) {
        return next();
    }

    if (req.session.usuario) {
        return next();
    }

    const redirectPath = encodeURIComponent(req.originalUrl || '/');
    return res.redirect(`/auth/login?redirect=${redirectPath}`);
}

app.use(requireAuth);

function hasProfessorAccess(usuarioSessao) {
    return !!usuarioSessao && ['PRO', 'ADM'].includes(usuarioSessao.role);
}

function getRoleLabel(role) {
    if (role === 'ADM') {
        return 'Administrador';
    }

    if (role === 'PRO') {
        return 'Professor';
    }

    if (role === 'STD') {
        return 'Aluno';
    }

    return role;
}

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

const BELT_OPTIONS = [
    { value: 'white', label: 'Branca' },
    { value: 'gray-white', label: 'Cinza e Branca' },
    { value: 'gray', label: 'Cinza' },
    { value: 'gray-black', label: 'Cinza e Preta' },
    { value: 'yellow-white', label: 'Amarela e Branca' },
    { value: 'yellow', label: 'Amarela' },
    { value: 'yellow-black', label: 'Amarela e Preta' },
    { value: 'orange-white', label: 'Laranja e Branca' },
    { value: 'orange', label: 'Laranja' },
    { value: 'orange-black', label: 'Laranja e Preta' },
    { value: 'green-white', label: 'Verde e Branca' },
    { value: 'green', label: 'Verde' },
    { value: 'green-black', label: 'Verde e Preta' },
    { value: 'blue', label: 'Azul' },
    { value: 'purple', label: 'Roxa' },
    { value: 'brown', label: 'Marrom' },
    { value: 'black', label: 'Preta' }
];

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

async function removeExistingUserImages(userId) {
    const idPrefix = `${userId}_`;
    const files = await fs.promises.readdir(uploadsDir);

    const filesToDelete = files.filter((fileName) => fileName.startsWith(idPrefix));

    await Promise.all(filesToDelete.map(async (fileName) => {
        const filePath = path.join(uploadsDir, fileName);
        await fs.promises.unlink(filePath);
    }));
}

async function replaceUserPhoto(usuario, tempFileName) {
    const timestamp = formatTimestampForFile(new Date());
    const finalFileName = `${usuario.id}_${timestamp}.jpg`;
    const tempFilePath = path.join(uploadsDir, tempFileName);
    const finalFilePath = path.join(uploadsDir, finalFileName);

    try {
        await removeExistingUserImages(usuario.id);
        const fileSize = await optimizeImageTo1MB(tempFilePath, finalFilePath);

        if (tempFilePath !== finalFilePath && fs.existsSync(tempFilePath)) {
            await fs.promises.unlink(tempFilePath);
        }

        usuario.photo = `/uploads/users/${finalFileName}`;
        await usuario.save();

        return { finalFileName, fileSize };
    } catch (error) {
        if (fs.existsSync(tempFilePath)) {
            await fs.promises.unlink(tempFilePath);
        }
        throw error;
    }
}

function getFileNameFromPhotoPath(photoPath) {
    if (typeof photoPath !== 'string') {
        return '';
    }

    return path.basename(photoPath);
}

function isTempPhotoPath(photoPath) {
    const fileName = getFileNameFromPhotoPath(photoPath);
    return fileName.startsWith('temp_');
}

async function deleteUserTempPhotoIfExists(usuario) {
    if (!isTempPhotoPath(usuario.photo)) {
        return false;
    }

    const fileName = getFileNameFromPhotoPath(usuario.photo);
    const filePath = path.join(uploadsDir, fileName);

    if (fs.existsSync(filePath)) {
        await fs.promises.unlink(filePath);
    }

    usuario.photo = '/uploads/users/default.jpg';
    await usuario.save();
    return true;
}

async function finalizePendingPhotoIfNeeded(usuario) {
    if (!isTempPhotoPath(usuario.photo)) {
        return null;
    }

    const tempFileName = getFileNameFromPhotoPath(usuario.photo);
    return replaceUserPhoto(usuario, tempFileName);
}

function buildUserFormViewModel(usuario, isEditMode) {
    const formData = usuario
        ? usuario.get({ plain: true })
        : {
            first_name: '',
            last_name: '',
            email: '',
            phone: '',
            birth_date: '',
            actual_belt: '',
            actual_degree: '0',
            wagi_size: '',
            zubon_size: '',
            obi_size: '',
            photo: '/uploads/users/default.jpg'
        };

    return {
        isEditMode,
        title: isEditMode ? 'Editar Aluno' : 'Novo Aluno',
        submitLabel: isEditMode ? 'Salvar alterações' : 'Enviar',
        formAction: isEditMode ? `/aluno/editar/${formData.id}` : '/aluno/cadastrar',
        usuario: formData,
        beltOptions: BELT_OPTIONS.map((option) => ({
            ...option,
            selected: option.value === formData.actual_belt
        }))
    };
}


// rota principal
app.get('/', (req, res) => {
    res.redirect('/aluno');
});

app.get('/dashboard', (req, res) => {
    res.redirect('/aluno');
});


// FUNÇÕES DE ALUNOS
app.get('/aluno', function(req, res) {
    const hasProfessorPrivileges = hasProfessorAccess(req.session.usuario);
    const queryOptions = {
        order: [['first_name', 'ASC']]
    };

    if (!hasProfessorPrivileges) {
        queryOptions.where = { user_status: 'A' };
    }

    Usuario.findAll(queryOptions).then(function(usuarios) {
        const lista = usuarios.map((u) => {
            const usuario = u.get({ plain: true });
            return {
                ...usuario,
                role_label: getRoleLabel(usuario.role),
                user_status_label: usuario.user_status === 'P' ? 'Pendente' : usuario.user_status === 'A' ? 'Ativo' : 'Cancelado',
                can_approve: hasProfessorPrivileges && usuario.user_status === 'P'
            };
        });
        res.render('aluno', {
            mensagem: req.query.mensagem || '',
            usuarios: lista,
            hasProfessorPrivileges
        });
    }).catch(function(err) {
        res.render('aluno', {
            mensagem: 'Erro ao carregar alunos: ' + err.message,
            usuarios: []
        });
    });
});

app.get('/aluno/novo', (req, res) => {
    const vm = buildUserFormViewModel(null, false);
    vm.mensagem = req.query.mensagem || '';
    res.render('formnovousuario', vm);
});

app.post('/aluno/cadastrar', upload.single('photo'), async (req, res) => {
    try {
        const senha = req.body.password2 || '';

        if (!req.body.password1 || req.body.password1 !== senha) {
            if (req.file) {
                const tempFilePath = path.join(uploadsDir, req.file.filename);
                if (fs.existsSync(tempFilePath)) {
                    await fs.promises.unlink(tempFilePath);
                }
            }

            const mensagem = 'As senhas não conferem.';
            return res.redirect(`/aluno/novo?mensagem=${encodeURIComponent(mensagem)}`);
        }

        if (senha.length < 8) {
            if (req.file) {
                const tempFilePath = path.join(uploadsDir, req.file.filename);
                if (fs.existsSync(tempFilePath)) {
                    await fs.promises.unlink(tempFilePath);
                }
            }

            const mensagem = 'A senha deve ter no mínimo 8 caracteres.';
            return res.redirect(`/aluno/novo?mensagem=${encodeURIComponent(mensagem)}`);
        }

        const passwordHash = await argon2.hash(senha);

        const usuario = await Usuario.create({
            first_name: req.body.first_name,
            last_name: req.body.last_name,
            email: req.body.email,
            password: passwordHash,
            role: 'STD',
            user_status: 'P',
            phone: req.body.phone,
            birth_date: req.body.birth_date,
            actual_belt: req.body.actual_belt,
            actual_degree: req.body.actual_degree,
            wagi_size: req.body.wagi_size,
            zubon_size: req.body.zubon_size,
            obi_size: req.body.obi_size
        });

        if (req.file) {
            // Cadastro pendente mantém foto temporária até aprovação.
            usuario.photo = `/uploads/users/${req.file.filename}`;
            await usuario.save();
            console.log(`Imagem temporária salva: ${req.file.filename}`);
        }

        const mensagem = 'Aluno criado com sucesso.';
        res.redirect(`/aluno?mensagem=${encodeURIComponent(mensagem)}`);
    } catch (err) {
        console.error('Erro no cadastro:', err);
        const mensagem = 'Erro ao criar aluno: ' + err.message;
        res.redirect(`/aluno?mensagem=${encodeURIComponent(mensagem)}`);
    }
});

app.get('/aluno/editar/:id', async (req, res) => {
    const alunoId = req.params.id;

    try {
        const usuario = await Usuario.findByPk(alunoId);
        if (!usuario) {
            const mensagem = 'Aluno não encontrado.';
            return res.redirect(`/aluno?mensagem=${encodeURIComponent(mensagem)}`);
        }

        return res.render('formnovousuario', buildUserFormViewModel(usuario, true));
    } catch (err) {
        const mensagem = 'Erro ao carregar aluno: ' + err.message;
        return res.redirect(`/aluno?mensagem=${encodeURIComponent(mensagem)}`);
    }
});

app.post('/aluno/editar/:id', upload.single('photo'), async (req, res) => {
    const alunoId = req.params.id;

    try {
        const usuario = await Usuario.findByPk(alunoId);
        if (!usuario) {
            if (req.file) {
                const tempFilePath = path.join(uploadsDir, req.file.filename);
                if (fs.existsSync(tempFilePath)) {
                    await fs.promises.unlink(tempFilePath);
                }
            }

            const mensagem = 'Aluno não encontrado.';
            return res.redirect(`/aluno?mensagem=${encodeURIComponent(mensagem)}`);
        }

        usuario.email = req.body.email;
        usuario.phone = req.body.phone;
        usuario.actual_belt = req.body.actual_belt;
        usuario.actual_degree = req.body.actual_degree;
        usuario.wagi_size = req.body.wagi_size;
        usuario.zubon_size = req.body.zubon_size;
        usuario.obi_size = req.body.obi_size;

        if (req.body.password1 || req.body.password2) {
            if (req.body.password1 !== req.body.password2) {
                if (req.file) {
                    const tempFilePath = path.join(uploadsDir, req.file.filename);
                    if (fs.existsSync(tempFilePath)) {
                        await fs.promises.unlink(tempFilePath);
                    }
                }

                const mensagem = 'As senhas não conferem.';
                return res.redirect(`/aluno?mensagem=${encodeURIComponent(mensagem)}`);
            }

            usuario.password = await argon2.hash(req.body.password2);
        }

        await usuario.save();

        if (req.file) {
            if (usuario.user_status === 'P') {
                await deleteUserTempPhotoIfExists(usuario);
                usuario.photo = `/uploads/users/${req.file.filename}`;
                await usuario.save();
                console.log(`Imagem temporária atualizada: ${req.file.filename}`);
            } else {
                const result = await replaceUserPhoto(usuario, req.file.filename);
                console.log(`Imagem atualizada: ${result.finalFileName} (${(result.fileSize / 1024).toFixed(2)}KB)`);
            }
        }

        const mensagem = 'Dados do aluno atualizados com sucesso.';
        return res.redirect(`/aluno?mensagem=${encodeURIComponent(mensagem)}`);
    } catch (err) {
        if (req.file) {
            const tempFilePath = path.join(uploadsDir, req.file.filename);
            if (fs.existsSync(tempFilePath)) {
                await fs.promises.unlink(tempFilePath);
            }
        }

        console.error('Erro ao atualizar aluno:', err);
        const mensagem = 'Erro ao atualizar aluno: ' + err.message;
        return res.redirect(`/aluno?mensagem=${encodeURIComponent(mensagem)}`);
    }
});
app.get('/aluno/status/:id', (req, res) => {
    if (!hasProfessorAccess(req.session.usuario)) {
        const mensagem = 'Apenas professor ou administrador pode aprovar cadastros.';
        return res.redirect(`/aluno?mensagem=${encodeURIComponent(mensagem)}`);
    }

    const alunoId = req.params.id;
    Usuario.findByPk(alunoId).then(async function(usuario) {
        if (usuario) {
            if (usuario.user_status !== 'P') {
                throw new Error('Somente cadastros pendentes podem ser aprovados');
            }

            usuario.user_status = 'A';
            await usuario.save();
            const finalizedPhoto = await finalizePendingPhotoIfNeeded(usuario);
            return finalizedPhoto;
        } else {
            throw new Error('Aluno não encontrado');
        }
    }).then(function(finalizedPhoto) {
        if (finalizedPhoto) {
            console.log(`Imagem aprovada: ${finalizedPhoto.finalFileName} (${(finalizedPhoto.fileSize / 1024).toFixed(2)}KB)`);
        }

        const mensagem = 'Cadastro aprovado com sucesso.';
        res.redirect(`/aluno?mensagem=${encodeURIComponent(mensagem)}`);
    }).catch(function(err) {
        const mensagem = 'Erro: ' + err.message;
        res.redirect(`/aluno?mensagem=${encodeURIComponent(mensagem)}`);
    });
});

app.get('/aluno/status/negar/:id', async (req, res) => {
    if (!hasProfessorAccess(req.session.usuario)) {
        const mensagem = 'Apenas professor ou administrador pode negar cadastros.';
        return res.redirect(`/aluno?mensagem=${encodeURIComponent(mensagem)}`);
    }

    const alunoId = req.params.id;

    try {
        const usuario = await Usuario.findByPk(alunoId);
        if (!usuario) {
            throw new Error('Aluno não encontrado');
        }

        if (usuario.user_status !== 'P') {
            throw new Error('Somente cadastros pendentes podem ser negados');
        }

        usuario.user_status = 'C';
        await usuario.save();
        await deleteUserTempPhotoIfExists(usuario);

        const mensagem = 'Cadastro negado com sucesso.';
        return res.redirect(`/aluno?mensagem=${encodeURIComponent(mensagem)}`);
    } catch (err) {
        const mensagem = 'Erro: ' + err.message;
        return res.redirect(`/aluno?mensagem=${encodeURIComponent(mensagem)}`);
    }
});


// FUNÇÕES DE PRESENÇAS
app.get('/presenca', function(req, res) {
    res.render('presenca');
});


// login
app.get('/auth/login', function(req, res) {
    if (req.session.usuario) {
        return res.redirect('/aluno');
    }

    res.render('login', {
        layout: false,
        erro: req.query.erro || '',
        aviso: req.query.aviso || '',
        redirect: req.query.redirect || '/aluno'
    });
});
app.post('/auth/verify', function(req, res) {
    const { email, password } = req.body;
    const redirect = typeof req.body.redirect === 'string' && req.body.redirect.startsWith('/')
        ? req.body.redirect
        : '/aluno';

    if (!email || !password) {
        const erro = encodeURIComponent('Informe e-mail e senha.');
        return res.redirect(`/auth/login?erro=${erro}&redirect=${encodeURIComponent(redirect)}`);
    }

    Usuario.findOne({ where: { email } }).then(async function(usuario) {
        if (!usuario) {
            const erro = encodeURIComponent('Credenciais inválidas.');
            return res.redirect(`/auth/login?erro=${erro}&redirect=${encodeURIComponent(redirect)}`);
        }

        let senhaValida = false;

        if (typeof usuario.password === 'string' && usuario.password.startsWith('$argon2')) {
            senhaValida = await argon2.verify(usuario.password, password);
        } else {
            senhaValida = usuario.password === password;

            if (senhaValida) {
                usuario.password = await argon2.hash(password);
                await usuario.save();
            }
        }

        if (!senhaValida) {
            const erro = encodeURIComponent('Credenciais inválidas.');
            return res.redirect(`/auth/login?erro=${erro}&redirect=${encodeURIComponent(redirect)}`);
        }

        if (usuario.user_status === 'P') {
            const aviso = encodeURIComponent('Seu cadastro está pendente de aprovação. Fale com o seu professor.');
            return res.redirect(`/auth/login?aviso=${aviso}&redirect=${encodeURIComponent(redirect)}`);
        }

        if (usuario.user_status === 'C') {
            const aviso = encodeURIComponent('Seu acesso está bloqueado. Se você acha que isso é algum engano, fale com o seu professor.');
            return res.redirect(`/auth/login?aviso=${aviso}&redirect=${encodeURIComponent(redirect)}`);
        }

        if (!['STD', 'PRO', 'ADM'].includes(usuario.role)) {
            const erro = encodeURIComponent('Seu nível de acesso não está autorizado para este portal.');
            return res.redirect(`/auth/login?erro=${erro}&redirect=${encodeURIComponent(redirect)}`);
        }

        req.session.usuario = {
            id: usuario.id,
            first_name: usuario.first_name,
            last_name: usuario.last_name,
            email: usuario.email,
            role: usuario.role
        };

        return res.redirect(redirect);
    }).catch(function(err) {
        const erro = encodeURIComponent('Erro ao verificar credenciais: ' + err.message);
        res.redirect(`/auth/login?erro=${erro}&redirect=${encodeURIComponent(redirect)}`);
    });
});

app.post('/auth/logout', function(req, res) {
    req.session.destroy(function() {
        res.clearCookie('oss.sid');
        const erro = encodeURIComponent('Sessão encerrada. Faça login novamente.');
        res.redirect(`/auth/login?erro=${erro}`);
    });
});


// ### CONFIGURAÇÕES GERAIS ### 
// engine de template de visualização
app.engine('handlebars', engine({ defaultLayout: 'main' }));
app.set('view engine', 'handlebars');


// execução do servidor
app.listen(8080, function() {
    console.clear();
    console.log('Servidor funcionando...');
    console.log('Acesse http://localhost:8080 para ver o app.');
});


