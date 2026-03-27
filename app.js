// configurações de ambiente
require('dotenv').config();

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
const { Op } = require('sequelize');
const moment = require('moment');
const Usuario = require('./models/Usuario');
const Presenca = require('./models/Presenca');
const { sequelize } = require('./models/db');
const generatedCode = require('./utils/usercode_generator');




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

// Carrega na seção a informação do Portal
app.use((req, res, next) => {
    res.locals.usuarioLogado = req.session.usuario || null;
    res.locals.viewingAs = req.session.viewingAs || null;

    const role = req.session.usuario ? req.session.usuario.role : null;
    res.locals.isRoleSTD = role === 'STD';
    res.locals.isRolePRO = role === 'PRO';
    res.locals.isRoleADM = role === 'ADM';

    if (role === 'ADM') {
        res.locals.portalMenuTitulo = 'PORTAL DO ADMINISTRADOR';
    } else if (role === 'PRO') {
        res.locals.portalMenuTitulo = 'PORTAL DO PROFESSOR';
    } else {
        res.locals.portalMenuTitulo = 'PORTAL DO ALUNO';
    }

    res.locals.useProfessorMenu = role === 'PRO' || role === 'ADM';
    next();
});

// Carrega lista de dependentes do titular logado para o menu
app.use(async (req, res, next) => {
    const usuario = req.session.usuario;
    if (usuario && !req.session.viewingAs) {
        try {
            const dependentes = await Usuario.findAll({
                where: { responsible_id: usuario.id, user_status: 'A' },
                attributes: ['id', 'first_name', 'last_name'],
                order: [['first_name', 'ASC']]
            });
            res.locals.dependentes = dependentes.length > 0
                ? dependentes.map(d => d.get({ plain: true }))
                : null;
        } catch (_err) {
            res.locals.dependentes = null;
        }
    } else {
        res.locals.dependentes = null;
    }
    next();
});

// Rotas isentas de verificação de login
function isPublicRoute(pathname) {
    return pathname === '/auth/login'
        || pathname === '/auth/verify'
        || pathname === '/aluno/novo'
        || pathname === '/aluno/cadastrar'
        || pathname === '/aluno/verificar-titular'
        || pathname.startsWith('/uploads/');
}

// Redirecionamento para o login caso não esteja autenticado
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

// Equiparação de acesso para professor e administrador
function hasProfessorAccess(usuarioSessao) {
    return !!usuarioSessao && ['PRO', 'ADM'].includes(usuarioSessao.role);
}

function getDefaultRedirectByRole(role) {
    return '/dashboard';
}

// Helper para exibir o nome completo do perfil do usuário
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

// Faixas x valor x label
const BELT_OPTIONS = [
    { value: 'white', label: 'Branca', order: 1 },
    { value: 'gray_white', label: 'Cinza e Branca', order: 2 },
    { value: 'gray', label: 'Cinza', order: 3 },
    { value: 'gray_black', label: 'Cinza e Preta', order: 4 },
    { value: 'yellow_white', label: 'Amarela e Branca', order: 5 },
    { value: 'yellow', label: 'Amarela', order: 6 },
    { value: 'yellow_black', label: 'Amarela e Preta', order: 7 },
    { value: 'orange_white', label: 'Laranja e Branca', order: 8 },
    { value: 'orange', label: 'Laranja', order: 9 },
    { value: 'orange_black', label: 'Laranja e Preta', order: 10 },
    { value: 'green_white', label: 'Verde e Branca', order: 11 },
    { value: 'green', label: 'Verde', order: 12 },
    { value: 'green_black', label: 'Verde e Preta', order: 13 },
    { value: 'blue', label: 'Azul', order: 14 },
    { value: 'purple', label: 'Roxa', order: 15 },
    { value: 'brown', label: 'Marrom', order: 16 },
    { value: 'black', label: 'Preta', order: 17 }
];
const BLACK_BELT_VALUE = 'black';

const BELT_MAP = BELT_OPTIONS.reduce((acc, option) => {
    acc[option.value] = option;
    return acc;
}, {});

function getMaxDegreeForBelt(actualBelt) {
    return actualBelt === BLACK_BELT_VALUE ? 6 : 4;
}

function getDegreeValidationMessage(actualBelt) {
    return actualBelt === BLACK_BELT_VALUE
        ? 'Faixa preta permite graus entre 0 e 6.'
        : 'A faixa selecionada permite graus entre 0 e 4.';
}

function parseDegreeStrict(value) {
    const normalized = String(value ?? '').trim();
    if (!/^\d+$/.test(normalized)) {
        return null;
    }

    const degree = parseInt(normalized, 10);
    return Number.isInteger(degree) ? degree : null;
}

function normalizeDegreeForBelt(actualBelt, actualDegree) {
    const parsedDegree = parseDegree(actualDegree);
    const maxDegree = getMaxDegreeForBelt(actualBelt);
    return Math.min(Math.max(parsedDegree, 0), maxDegree);
}

function validateBeltAndDegree(actualBelt, actualDegree) {
    const beltValue = String(actualBelt || '').trim();
    if (!beltValue || !BELT_MAP[beltValue]) {
        return {
            isValid: false,
            field: 'actual_belt',
            message: 'Faixa selecionada é inválida.'
        };
    }

    const parsedDegree = parseDegreeStrict(actualDegree);
    const maxDegree = getMaxDegreeForBelt(beltValue);

    if (parsedDegree === null || parsedDegree < 0 || parsedDegree > maxDegree) {
        return {
            isValid: false,
            field: 'actual_degree',
            message: getDegreeValidationMessage(beltValue)
        };
    }

    return {
        isValid: true,
        beltValue,
        degreeValue: String(parsedDegree)
    };
}

function parseDegree(value) {
    const degree = parseInt(value, 10);
    if (!Number.isInteger(degree) || degree < 0) {
        return 0;
    }
    return degree;
}

function getBeltDisplayData(actualBelt, actualDegree) {
    const beltValue = (actualBelt || '').trim();
    const degree = normalizeDegreeForBelt(beltValue, actualDegree);

    if (!beltValue || !BELT_MAP[beltValue]) {
        return {
            beltValue,
            beltLabel: '-',
            degree,
            degreeLabel: 'Nenhum Grau',
            summaryLabel: '-',
            imagePath: '/img/belts/white_0.png'
        };
    }

    const beltLabel = BELT_MAP[beltValue].label;
    const degreeLabel = degree === 0 ? 'Nenhum Grau' : `${degree} ${degree === 1 ? 'Grau' : 'Graus'}`;

    return {
        beltValue,
        beltLabel,
        degree,
        degreeLabel,
        summaryLabel: `${beltLabel} - ${degreeLabel}`,
        imagePath: `/img/belts/${beltValue}_${degree}.png`
    };
}

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

// ### CONFIGURAÇÃO DAS ROTAS ###
// rota principal
app.get('/', (req, res) => {
    return res.redirect(getDefaultRedirectByRole(req.session.usuario.role));
});

app.get('/dashboard', (req, res) => {
    if (hasProfessorAccess(req.session.usuario)) {
        return res.render('dashboardprofessor');
    }

    return res.render('dashboardaluno');
});

app.get('/dashboardaluno', (req, res) => {
    return res.redirect('/dashboard');
});


// FUNÇÕES DE ALUNOS
app.get('/aluno', async (req, res) => {
    const hasProfessorPrivileges = hasProfessorAccess(req.session.usuario);
    const searchTerm = (req.query.q || '').trim();
    const pageRaw = parseInt(req.query.page, 10);
    const currentPageRequested = Number.isInteger(pageRaw) && pageRaw > 0 ? pageRaw : 1;
    const itemsPerPage = 10;
    const pagesPerBlock = 8;

    try {
        const whereClauses = [];

        if (!hasProfessorPrivileges) {
            whereClauses.push({ user_status: 'A' });
        }

        if (searchTerm) {
            const normalizedPhone = searchTerm.replace(/\D/g, '');
            const searchFilters = [
                { first_name: { [Op.like]: `%${searchTerm}%` } },
                { last_name: { [Op.like]: `%${searchTerm}%` } },
                { email: { [Op.like]: `%${searchTerm}%` } }
            ];

            if (normalizedPhone) {
                searchFilters.push({ phone: { [Op.like]: `%${normalizedPhone}%` } });
            }

            whereClauses.push({ [Op.or]: searchFilters });
        }

        const where = whereClauses.length === 0
            ? undefined
            : whereClauses.length === 1
                ? whereClauses[0]
                : { [Op.and]: whereClauses };

        const usuarios = await Usuario.findAll({
            where,
            order: [['first_name', 'ASC'], ['last_name', 'ASC']]
        });

        const lista = usuarios.map((u) => {
            const usuario = u.get({ plain: true });
            const beltDisplay = getBeltDisplayData(usuario.actual_belt, usuario.actual_degree);

            return {
                ...usuario,
                role_label: getRoleLabel(usuario.role),
                user_status_label: usuario.user_status === 'P' ? 'Pendente' : usuario.user_status === 'A' ? 'Ativo' : 'Cancelado',
                can_approve: hasProfessorPrivileges && usuario.user_status === 'P',
                belt_label: beltDisplay.beltLabel,
                degree_label: beltDisplay.degreeLabel,
                belt_summary_label: beltDisplay.summaryLabel,
                belt_image_path: beltDisplay.imagePath
            };
        });

        const pendentes = hasProfessorPrivileges
            ? lista.filter((usuario) => usuario.user_status === 'P')
            : [];
        const ativos = hasProfessorPrivileges
            ? lista.filter((usuario) => usuario.user_status === 'A')
            : lista;
        const cancelados = hasProfessorPrivileges
            ? lista.filter((usuario) => usuario.user_status === 'C')
            : [];
        const listaOrdenada = hasProfessorPrivileges
            ? pendentes.concat(ativos, cancelados)
            : ativos;

        const totalItems = listaOrdenada.length;
        const totalPages = Math.max(1, Math.ceil(totalItems / itemsPerPage));
        const currentPage = Math.min(currentPageRequested, totalPages);
        const startIndex = (currentPage - 1) * itemsPerPage;
        const usuariosPaginados = listaOrdenada.slice(startIndex, startIndex + itemsPerPage);

        const startPage = Math.floor((currentPage - 1) / pagesPerBlock) * pagesPerBlock + 1;
        const endPage = Math.min(startPage + pagesPerBlock - 1, totalPages);
        const visiblePages = endPage - startPage + 1;

        const pageNumbers = Array.from({ length: visiblePages }, (_unused, index) => {
            const pageNumber = startPage + index;
            return {
                number: pageNumber,
                isCurrent: pageNumber === currentPage
            };
        });

        return res.render('aluno', {
            mensagem: req.query.mensagem || '',
            usuarios: usuariosPaginados,
            hasProfessorPrivileges,
            searchTerm,
            hasSearchTerm: !!searchTerm,
            searchTermEncoded: encodeURIComponent(searchTerm),
            pagination: {
                currentPage,
                totalPages,
                totalItems,
                hasPrev: currentPage > 1,
                hasNext: currentPage < totalPages,
                prevPage: currentPage > 1 ? currentPage - 1 : 1,
                nextPage: currentPage < totalPages ? currentPage + 1 : totalPages,
                pageNumbers
            }
        });
    } catch (err) {
        return res.render('aluno', {
            mensagem: 'Erro ao carregar alunos: ' + err.message,
            usuarios: [],
            hasProfessorPrivileges,
            searchTerm,
            hasSearchTerm: !!searchTerm,
            searchTermEncoded: encodeURIComponent(searchTerm),
            pagination: {
                currentPage: 1,
                totalPages: 1,
                totalItems: 0,
                hasPrev: false,
                hasNext: false,
                prevPage: 1,
                nextPage: 1,
                pageNumbers: [{ number: 1, isCurrent: true }]
            }
        });
    }
});

// Verifica se o e-mail pertence a um titular ativo (chamada AJAX pública)
app.post('/aluno/verificar-titular', async (req, res) => {
    const email = (req.body.email || '').trim().toLowerCase();
    if (!email) {
        return res.json({ ok: false, mensagem: 'Informe o e-mail.' });
    }

    try {
        const titular = await Usuario.findOne({
            where: { email, user_status: 'A', responsible_id: null }
        });

        if (!titular) {
            return res.json({ ok: false, mensagem: 'E-mail não encontrado ou o usuário ainda não foi aprovado.' });
        }

        return res.json({ ok: true, id: titular.id, first_name: titular.first_name, last_name: titular.last_name, email: titular.email });
    } catch (err) {
        return res.json({ ok: false, mensagem: 'Erro ao verificar: ' + err.message });
    }
});

// Troca a visualização para a conta de um dependente
app.get('/conta/trocar/:id', async (req, res) => {
    const dependenteId = parseInt(req.params.id, 10);
    const usuarioLogado = req.session.usuario;

    if (!usuarioLogado) {
        return res.redirect('/auth/login');
    }

    try {
        const dependente = await Usuario.findByPk(dependenteId);
        if (!dependente || dependente.responsible_id !== usuarioLogado.id) {
            const mensagem = 'Dependente não encontrado ou sem permissão.';
            return res.redirect(`/dashboard?mensagem=${encodeURIComponent(mensagem)}`);
        }

        if (dependente.user_status !== 'A') {
            const mensagem = 'Este dependente ainda não foi aprovado por um professor/administrador.';
            return res.redirect(`/dashboard?mensagem=${encodeURIComponent(mensagem)}`);
        }

        req.session.viewingAs = {
            id: dependente.id,
            first_name: dependente.first_name,
            last_name: dependente.last_name,
            responsible_id: dependente.responsible_id
        };

        return res.redirect('/dashboard');
    } catch (err) {
        const mensagem = 'Erro ao trocar conta: ' + err.message;
        return res.redirect(`/dashboard?mensagem=${encodeURIComponent(mensagem)}`);
    }
});

// Volta para a conta titular
app.get('/conta/voltar', (req, res) => {
    req.session.viewingAs = null;
    return res.redirect('/dashboard');
});

app.get('/aluno/novo', (req, res) => {
    const vm = buildUserFormViewModel(null, false);
    
    // Capturar mensagem da sessão se existir
    if (req.session.mensagem) {
        vm.mensagem = req.session.mensagem;
        vm.tipoMensagem = req.session.tipoMensagem || 'info';
        vm.redirectUrl = req.session.redirectUrl;
        vm.redirectDelay = req.session.redirectDelay;
        
        // Limpar dados da sessão após usar
        delete req.session.mensagem;
        delete req.session.tipoMensagem;
        delete req.session.redirectUrl;
        delete req.session.redirectDelay;
    } else {
        // Capturar mensagem de query param se existir (compatibilidadecom redirecionamentos antigos)
        vm.mensagem = req.query.mensagem || '';
        vm.tipoMensagem = req.query.tipo || 'info';
    }
    
    res.render('formnovousuario', vm);
});

app.post('/aluno/cadastrar', upload.single('photo'), async (req, res) => {
    // Função para renderizar o formulário com dados preservados em caso de erro
    const renderFormWithError = (errorMessage, fieldErrors = {}) => {
        const responsibleId = req.body.responsible_id ? parseInt(req.body.responsible_id, 10) : null;
        
        const formData = {
            first_name: req.body.first_name || '',
            last_name: req.body.last_name || '',
            email: req.body.email || '',
            phone: req.body.phone || '',
            birth_date: req.body.birth_date || '',
            actual_belt: req.body.actual_belt || '',
            actual_degree: req.body.actual_degree || '0',
            wagi_size: req.body.wagi_size || '',
            zubon_size: req.body.zubon_size || '',
            obi_size: req.body.obi_size || '',
            photo: '/uploads/users/default.jpg',
            responsible_id: responsibleId
        };

        const vm = {
            isEditMode: false,
            title: 'Novo Aluno',
            submitLabel: 'Enviar',
            formAction: '/aluno/cadastrar',
            usuario: formData,
            beltOptions: BELT_OPTIONS.map((option) => ({
                ...option,
                selected: option.value === formData.actual_belt
            })),
            mensagem: errorMessage,
            tipoMensagem: 'erro',
            camposErro: fieldErrors
        };

        res.render('formnovousuario', vm);
    };

    try {
        const responsibleId = req.body.responsible_id ? parseInt(req.body.responsible_id, 10) : null;
        const isDependent = !!responsibleId;
        let titular = null;
        const beltDegreeValidation = validateBeltAndDegree(req.body.actual_belt, req.body.actual_degree);

        // Validar titular se for dependente
        if (isDependent) {
            titular = await Usuario.findByPk(responsibleId);
            if (!titular || titular.user_status !== 'A' || titular.responsible_id !== null) {
                if (req.file) {
                    const tempFilePath = path.join(uploadsDir, req.file.filename);
                    if (fs.existsSync(tempFilePath)) {
                        await fs.promises.unlink(tempFilePath);
                    }
                }
                return renderFormWithError('Conta titular inválida ou não encontrada.');
            }
        }

        const senha = req.body.password2 || '';
        const fieldErrors = {};

        if (!req.body.password1 || req.body.password1 !== senha) {
            if (req.file) {
                const tempFilePath = path.join(uploadsDir, req.file.filename);
                if (fs.existsSync(tempFilePath)) {
                    await fs.promises.unlink(tempFilePath);
                }
            }
            fieldErrors.password = 'As senhas não conferem.';
            return renderFormWithError('Corrija os campos em desconformidade abaixo.', fieldErrors);
        }

        if (senha.length < 8) {
            if (req.file) {
                const tempFilePath = path.join(uploadsDir, req.file.filename);
                if (fs.existsSync(tempFilePath)) {
                    await fs.promises.unlink(tempFilePath);
                }
            }
            fieldErrors.password = 'A senha deve ter no mínimo 8 caracteres.';
            return renderFormWithError('Corrija os campos em desconformidade abaixo.', fieldErrors);
        }

        if (!beltDegreeValidation.isValid) {
            if (req.file) {
                const tempFilePath = path.join(uploadsDir, req.file.filename);
                if (fs.existsSync(tempFilePath)) {
                    await fs.promises.unlink(tempFilePath);
                }
            }

            fieldErrors[beltDegreeValidation.field] = beltDegreeValidation.message;
            return renderFormWithError('Corrija os campos em desconformidade abaixo.', fieldErrors);
        }

        const passwordHash = await argon2.hash(senha);

        let emailFinal = (req.body.email || '').trim().toLowerCase();
        if (isDependent) {
            emailFinal = (titular.email || '').trim().toLowerCase();
        }

        const usuario = await Usuario.create({
            user_code: generatedCode(),
            first_name: req.body.first_name,
            last_name: req.body.last_name,
            email: emailFinal,
            password: passwordHash,
            role: 'STD',
            user_status: 'P',
            phone: req.body.phone,
            birth_date: req.body.birth_date,
            actual_belt: beltDegreeValidation.beltValue,
            actual_degree: beltDegreeValidation.degreeValue,
            wagi_size: req.body.wagi_size,
            zubon_size: req.body.zubon_size,
            obi_size: req.body.obi_size,
            responsible_id: responsibleId || null
        });

        if (req.file) {
            // Cadastro pendente mantém foto temporária até aprovação.
            usuario.photo = `/uploads/users/${req.file.filename}`;
            await usuario.save();
        }

        // Armazenar mensagem de sucesso na sessão com indicador de redirecionamento
        req.session.mensagem = isDependent ? 'Cadastro de dependente enviado com sucesso.' : 'Aluno criado com sucesso.';
        req.session.tipoMensagem = 'sucesso';
        req.session.redirectUrl = '/auth/login';
        req.session.redirectDelay = 3000; // 3 segundos

        res.redirect(`/aluno/novo?sucesso=1`);
    } catch (err) {
        console.error('Erro no cadastro:', err);
        
        // Extrair mensagens de erro de validação do Sequelize
        const fieldErrors = {};
        let mensagemGeral = 'Erro ao criar aluno. ';

        if (err.name === 'SequelizeValidationError') {
            err.errors.forEach((error) => {
                if (error.path) {
                    // Traduzir erros comuns
                    if (error.path === 'email' && error.type === 'unique violation') {
                        fieldErrors[error.path] = 'Este e-mail já está cadastrado.';
                    } else if (error.path === 'email' && error.type === 'Validation isEmail') {
                        fieldErrors[error.path] = 'E-mail inválido.';
                    } else if (error.path === 'phone' && error.type === 'Validation is') {
                        fieldErrors[error.path] = 'Telefone deve conter 11 dígitos.';
                    } else if (error.path === 'birth_date') {
                        fieldErrors[error.path] = 'Data de nascimento inválida ou futura.';
                    } else if (error.path === 'actual_belt') {
                        fieldErrors[error.path] = 'Faixa selecionada é inválida.';
                    } else if (error.path === 'actual_degree') {
                        fieldErrors[error.path] = 'Grau inválido para a faixa selecionada.';
                    } else {
                        fieldErrors[error.path] = error.message;
                    }
                }
            });
            mensagemGeral = 'Corrija os campos em desconformidade abaixo.';
        } else if (err.name === 'SequelizeUniqueConstraintError') {
            const field = err.fields ? Object.keys(err.fields)[0] : 'email';
            if (field === 'email') {
                fieldErrors[field] = 'Este e-mail já está cadastrado.';
            } else {
                fieldErrors[field] = `${field} já existe no sistema.`;
            }
            mensagemGeral = 'Corrija os campos em desconformidade abaixo.';
        } else {
            mensagemGeral += err.message;
        }

        if (req.file) {
            const tempFilePath = path.join(uploadsDir, req.file.filename);
            if (fs.existsSync(tempFilePath)) {
                fs.unlink(tempFilePath, (unlinkErr) => {
                    if (unlinkErr) console.error('Erro ao deletar arquivo temporário:', unlinkErr);
                });
            }
        }

        renderFormWithError(mensagemGeral, fieldErrors);
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
    const beltDegreeValidation = validateBeltAndDegree(req.body.actual_belt, req.body.actual_degree);

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

        if (!beltDegreeValidation.isValid) {
            if (req.file) {
                const tempFilePath = path.join(uploadsDir, req.file.filename);
                if (fs.existsSync(tempFilePath)) {
                    await fs.promises.unlink(tempFilePath);
                }
            }

            const mensagem = beltDegreeValidation.message;
            return res.redirect(`/aluno?mensagem=${encodeURIComponent(mensagem)}`);
        }

        usuario.actual_belt = beltDegreeValidation.beltValue;
        usuario.actual_degree = beltDegreeValidation.degreeValue;
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

// Retorna o user_code efetivo (viewingAs ou logado)
async function getEffectiveUserCode(req) {
    if (req.session.viewingAs) {
        const dep = await Usuario.findByPk(req.session.viewingAs.id);
        return dep ? dep.user_code : null;
    }
    return req.session.usuario ? req.session.usuario.user_code : null;
}

function buildPresencaViewModel(p) {
    const plain = p.get ? p.get({ plain: true }) : p;
    const statusMap = { P: 'Pendente', A: 'Aprovada', N: 'Negada', C: 'Cancelada' };
    const statusClassMap = { P: 'text-warning', A: 'text-success', N: 'text-danger', C: 'text-secondary' };
    const classTypeDisplayMap = { Integral: 'Integral', Gi: 'Gi (1ª Aula)', 'No-Gi': 'No-Gi (2ª Aula)' };
    return {
        ...plain,
        request_date_formatted: moment(plain.request_date).format('DD/MM/YYYY'),
        request_date_ts: moment(plain.createdAt || plain.request_date).format('DD/MM/YYYY HH:mm:ss'),
        request_date_iso: moment(plain.request_date).format('YYYY-MM-DD'),
        status_label: statusMap[plain.status] || plain.status,
        status_class: statusClassMap[plain.status] || '',
        class_type_display: classTypeDisplayMap[plain.class_type] || plain.class_type
    };
}

app.get('/presenca', async (req, res) => {
    const pageRaw = parseInt(req.query.page, 10);
    const currentPageRequested = Number.isInteger(pageRaw) && pageRaw > 0 ? pageRaw : 1;
    const itemsPerPage = 10;
    const pagesPerBlock = 8;

    try {
        const hasProfessorPrivileges = hasProfessorAccess(req.session.usuario);
        let listaCompleta = [];

        if (hasProfessorPrivileges) {
            const pendentes = await Presenca.findAll({
                where: { status: 'P' },
                order: [['request_date', 'DESC']]
            });

            const userCodes = [...new Set(pendentes.map((p) => p.user_code).filter(Boolean))];
            const usuarios = userCodes.length > 0
                ? await Usuario.findAll({
                    where: { user_code: { [Op.in]: userCodes } },
                    attributes: ['user_code', 'first_name', 'last_name', 'photo']
                })
                : [];

            const usuarioMap = usuarios.reduce((acc, u) => {
                const plain = u.get({ plain: true });
                acc[plain.user_code] = {
                    fullName: `${plain.first_name || ''} ${plain.last_name || ''}`.trim() || plain.user_code,
                    photo: plain.photo || '/uploads/users/default.jpg'
                };
                return acc;
            }, {});

            listaCompleta = pendentes.map((p) => {
                const vm = buildPresencaViewModel(p);
                const aluno = usuarioMap[vm.user_code] || {
                    fullName: vm.user_code,
                    photo: '/uploads/users/default.jpg'
                };
                return {
                    ...vm,
                    aluno_nome: aluno.fullName,
                    aluno_nome_completo: aluno.fullName,
                    aluno_photo: aluno.photo
                };
            });
        } else {
            const userCode = await getEffectiveUserCode(req);
            if (!userCode) {
                return res.redirect('/auth/login');
            }

            const todasPresencas = await Presenca.findAll({
                where: { user_code: userCode },
                order: [['request_date', 'DESC']]
            });

            listaCompleta = todasPresencas.map(buildPresencaViewModel);
        }

        const totalItems = listaCompleta.length;
        const totalPages = Math.max(1, Math.ceil(totalItems / itemsPerPage));
        const currentPage = Math.min(currentPageRequested, totalPages);
        const startIndex = (currentPage - 1) * itemsPerPage;
        const presencasPaginadas = listaCompleta.slice(startIndex, startIndex + itemsPerPage);

        const startPage = Math.floor((currentPage - 1) / pagesPerBlock) * pagesPerBlock + 1;
        const endPage = Math.min(startPage + pagesPerBlock - 1, totalPages);
        const pageNumbers = Array.from({ length: endPage - startPage + 1 }, (_u, i) => ({
            number: startPage + i,
            isCurrent: startPage + i === currentPage
        }));

        return res.render('presenca', {
            mensagem: req.query.mensagem || '',
            tipoMensagem: req.query.tipo || 'danger',
            presencas: presencasPaginadas,
            todasPresencasJSON: hasProfessorPrivileges ? '[]' : JSON.stringify(listaCompleta),
            hasProfessorPrivileges,
            pagination: {
                currentPage,
                totalPages,
                totalItems,
                hasPrev: currentPage > 1,
                hasNext: currentPage < totalPages,
                prevPage: currentPage > 1 ? currentPage - 1 : 1,
                nextPage: currentPage < totalPages ? currentPage + 1 : totalPages,
                pageNumbers
            }
        });
    } catch (err) {
        const hasProfessorPrivileges = hasProfessorAccess(req.session.usuario);
        return res.render('presenca', {
            mensagem: 'Erro ao carregar presenças: ' + err.message,
            presencas: [],
            todasPresencasJSON: '[]',
            hasProfessorPrivileges,
            pagination: {
                currentPage: 1, totalPages: 1, totalItems: 0,
                hasPrev: false, hasNext: false, prevPage: 1, nextPage: 1,
                pageNumbers: [{ number: 1, isCurrent: true }]
            }
        });
    }
});

app.post('/presenca/status/:id/aprovar', async (req, res) => {
    if (!hasProfessorAccess(req.session.usuario)) {
        return res.json({ ok: false, mensagem: 'Apenas professor ou administrador pode aprovar solicitações.' });
    }

    try {
        const presencaId = parseInt(req.params.id, 10);
        if (!Number.isInteger(presencaId)) {
            throw new Error('ID inválido.');
        }

        const presenca = await Presenca.findByPk(presencaId);
        if (!presenca) {
            throw new Error('Solicitação não encontrada.');
        }
        if (presenca.status !== 'P') {
            throw new Error('Somente solicitações pendentes podem ser aprovadas.');
        }

        presenca.status = 'A';
        presenca.processed_by = req.session.usuario.user_code;
        await presenca.save();

        return res.json({ ok: true, mensagem: 'Solicitação aprovada com sucesso.' });
    } catch (err) {
        return res.json({ ok: false, mensagem: 'Erro ao aprovar solicitação: ' + err.message });
    }
});

app.post('/presenca/status/:id/negar', async (req, res) => {
    if (!hasProfessorAccess(req.session.usuario)) {
        return res.json({ ok: false, mensagem: 'Apenas professor ou administrador pode negar solicitações.' });
    }

    try {
        const presencaId = parseInt(req.params.id, 10);
        if (!Number.isInteger(presencaId)) {
            throw new Error('ID inválido.');
        }

        const observation = String(req.body.observation || '').trim();
        if (!observation) {
            throw new Error('Informe a observação para negar a solicitação.');
        }

        const presenca = await Presenca.findByPk(presencaId);
        if (!presenca) {
            throw new Error('Solicitação não encontrada.');
        }
        if (presenca.status !== 'P') {
            throw new Error('Somente solicitações pendentes podem ser negadas.');
        }

        presenca.status = 'N';
        presenca.observation = observation;
        presenca.processed_by = req.session.usuario.user_code;
        await presenca.save();

        return res.json({ ok: true, mensagem: 'Solicitação negada com sucesso.' });
    } catch (err) {
        return res.json({ ok: false, mensagem: 'Erro ao negar solicitação: ' + err.message });
    }
});

app.post('/presenca/solicitar', async (req, res) => {
    try {
        const userCode = await getEffectiveUserCode(req);
        if (!userCode) {
            return res.json({ ok: false, mensagem: 'Não autenticado.' });
        }

        const { dates, classTypes } = req.body;

        if (!Array.isArray(dates) || dates.length === 0) {
            return res.json({ ok: false, mensagem: 'Nenhuma data selecionada.' });
        }

        const today = moment().startOf('day');
        const limitDate = moment().subtract(15, 'days').startOf('day');
        const results = [];
        const errors = [];

        for (const dateStr of dates) {
            const date = moment(dateStr, 'YYYY-MM-DD', true);

            if (!date.isValid()) {
                errors.push({ date: dateStr, error: 'Data inválida.' });
                continue;
            }
            if (date.isAfter(today)) {
                errors.push({ date: dateStr, error: 'Não é permitido solicitar para datas futuras.' });
                continue;
            }
            if (date.isBefore(limitDate)) {
                errors.push({ date: dateStr, error: `Anterior ao limite de 15 dias (${limitDate.format('DD/MM/YYYY')}).` });
                continue;
            }

            const dayStart = date.clone().startOf('day').toDate();
            const dayEnd = date.clone().endOf('day').toDate();
            const existing = await Presenca.findOne({
                where: {
                    user_code: userCode,
                    request_date: { [Op.between]: [dayStart, dayEnd] },
                    status: { [Op.ne]: 'C' }
                }
            });
            if (existing) {
                errors.push({ date: dateStr, error: 'Já existe uma solicitação para este dia.' });
                continue;
            }

            const dayOfWeek = date.day(); // 0=Dom ... 2=Ter
            let class_type = 'Integral';
            if (dayOfWeek === 2) {
                const ct = classTypes && classTypes[dateStr] ? classTypes[dateStr] : 'Integral';
                if (!['Integral', 'Gi', 'No-Gi'].includes(ct)) {
                    errors.push({ date: dateStr, error: 'Tipo de aula inválido.' });
                    continue;
                }
                class_type = ct;
            }

            const presenca = await Presenca.create({
                request_date: date.toDate(),
                user_code: userCode,
                status: 'P',
                class_type
            });

            const vm = buildPresencaViewModel(presenca);
            results.push(vm);
        }

        return res.json({ ok: true, results, errors });
    } catch (err) {
        return res.json({ ok: false, mensagem: 'Erro interno: ' + err.message });
    }
});

app.post('/presenca/cancelar/:id', async (req, res) => {
    try {
        const userCode = await getEffectiveUserCode(req);
        if (!userCode) {
            return res.json({ ok: false, mensagem: 'Não autenticado.' });
        }

        const presencaId = parseInt(req.params.id, 10);
        if (!Number.isInteger(presencaId)) {
            return res.json({ ok: false, mensagem: 'ID inválido.' });
        }

        const presenca = await Presenca.findByPk(presencaId);
        if (!presenca) {
            return res.json({ ok: false, mensagem: 'Solicitação não encontrada.' });
        }
        if (presenca.user_code !== userCode) {
            return res.json({ ok: false, mensagem: 'Sem permissão para cancelar esta solicitação.' });
        }
        if (presenca.status !== 'P') {
            return res.json({ ok: false, mensagem: 'Apenas solicitações pendentes podem ser canceladas.' });
        }

        presenca.status = 'C';
        await presenca.save();

        return res.json({ ok: true });
    } catch (err) {
        return res.json({ ok: false, mensagem: 'Erro ao cancelar: ' + err.message });
    }
});


// login
app.get('/auth/login', function(req, res) {
    if (req.session.usuario) {
        return res.redirect(getDefaultRedirectByRole(req.session.usuario.role));
    }

    const redirect = typeof req.query.redirect === 'string' && req.query.redirect.startsWith('/')
        ? req.query.redirect
        : '/dashboard';

    res.render('login', {
        layout: false,
        erro: req.query.erro || '',
        aviso: req.query.aviso || '',
        redirect
    });
});
app.post('/auth/verify', function(req, res) {
    const { email, password } = req.body;
    const requestedRedirect = typeof req.body.redirect === 'string' && req.body.redirect.startsWith('/')
        ? req.body.redirect
        : '/dashboard';

    if (!email || !password) {
        const erro = encodeURIComponent('Informe e-mail e senha.');
        return res.redirect(`/auth/login?erro=${erro}&redirect=${encodeURIComponent(requestedRedirect)}`);
    }

    Usuario.findAll({ where: { email: (email || '').trim().toLowerCase() } }).then(async function(usuarios) {
        if (!usuarios || usuarios.length === 0) {
            const erro = encodeURIComponent('Credenciais inválidas.');
            return res.redirect(`/auth/login?erro=${erro}&redirect=${encodeURIComponent(requestedRedirect)}`);
        }

        const candidatosComSenhaValida = [];

        for (const candidato of usuarios) {
            let senhaCandidataValida = false;

            if (typeof candidato.password === 'string' && candidato.password.startsWith('$argon2')) {
                senhaCandidataValida = await argon2.verify(candidato.password, password);
            } else {
                senhaCandidataValida = candidato.password === password;

                if (senhaCandidataValida) {
                    candidato.password = await argon2.hash(password);
                    await candidato.save();
                }
            }

            if (senhaCandidataValida) {
                candidatosComSenhaValida.push(candidato);
            }
        }

        if (candidatosComSenhaValida.length === 0) {
            const erro = encodeURIComponent('Credenciais inválidas.');
            return res.redirect(`/auth/login?erro=${erro}&redirect=${encodeURIComponent(requestedRedirect)}`);
        }

        const usuario = candidatosComSenhaValida.find((item) => item.user_status === 'A') || candidatosComSenhaValida[0];

        if (usuario.user_status === 'P') {
            const aviso = encodeURIComponent('Seu cadastro está pendente de aprovação. Fale com o seu professor.');
            return res.redirect(`/auth/login?aviso=${aviso}&redirect=${encodeURIComponent(requestedRedirect)}`);
        }

        if (usuario.user_status === 'C') {
            const aviso = encodeURIComponent('Seu acesso está bloqueado. Se você acha que isso é algum engano, fale com o seu professor.');
            return res.redirect(`/auth/login?aviso=${aviso}&redirect=${encodeURIComponent(requestedRedirect)}`);
        }

        if (!['STD', 'PRO', 'ADM'].includes(usuario.role)) {
            const erro = encodeURIComponent('Seu nível de acesso não está autorizado para este portal.');
            return res.redirect(`/auth/login?erro=${erro}&redirect=${encodeURIComponent(requestedRedirect)}`);
        }

        req.session.usuario = {
            id: usuario.id,
            user_code: usuario.user_code,
            first_name: usuario.first_name,
            last_name: usuario.last_name,
            email: usuario.email,
            role: usuario.role
        };

        const redirect = requestedRedirect === '/aluno' || requestedRedirect === '/dashboardaluno'
            ? getDefaultRedirectByRole(usuario.role)
            : requestedRedirect;

        return res.redirect(redirect);
    }).catch(function(err) {
        const erro = encodeURIComponent('Erro ao verificar credenciais: ' + err.message);
        res.redirect(`/auth/login?erro=${erro}&redirect=${encodeURIComponent(requestedRedirect)}`);
    });
});

app.post('/auth/logout', function(req, res) {
    req.session.destroy(function() {
        res.clearCookie('oss.sid');
        const erro = encodeURIComponent('Sessão encerrada. Faça login novamente.');
        res.redirect(`/auth/login?erro=${erro}`);
    });
});





// ### FORMATADORES PARA HANDLEBARS ###
const Handlebars = require("handlebars");

// data no formato DD/MM/YYYY
Handlebars.registerHelper("formatDate", function (date) {
    if (!date) return "";
    return moment(date).format("DD/MM/YYYY");
});


// hora no formato HH:mm:ss
Handlebars.registerHelper("formatTime", function (timestamp) {
  if (!timestamp) return "";
  return moment(timestamp).format("HH:mm:ss");
});


// data hora no formato dd/mm/yyyy HH:mm:ss
Handlebars.registerHelper("formatTimestamp", function (timestamp) {
    if (!timestamp) return "";
    return moment(timestamp).format("DD/MM/YYYY HH:mm:ss");
});

// formatação do telefone para o formato (XX) XXXXX-XXXX
Handlebars.registerHelper("formatPhone", function (phone) {
  if (!phone) return "";
  const cleaned = ('' + phone).replace(/\D/g, '');
  const match = cleaned.match(/^(\d{2})(\d{5})(\d{4})$/);
  if (match) {
    return `(${match[1]}) ${match[2]}-${match[3]}`;
  }
  return phone;
});

// Helper para comparação de igualdade
Handlebars.registerHelper("eq", function (a, b) {
  return a === b;
});

async function ensureUsuarioEmailNotUnique() {
    const dialect = sequelize.getDialect();

    if (dialect !== 'mysql' && dialect !== 'mariadb') {
        return;
    }

    const [indexes] = await sequelize.query(`
        SELECT INDEX_NAME
        FROM INFORMATION_SCHEMA.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'tb_usuarios'
          AND COLUMN_NAME = 'email'
          AND NON_UNIQUE = 0
          AND INDEX_NAME <> 'PRIMARY'
    `);

    for (const row of indexes) {
        if (!row || !row.INDEX_NAME) {
            continue;
        }

        await sequelize.query(`ALTER TABLE tb_usuarios DROP INDEX \`${row.INDEX_NAME}\``);
        console.log(`Indice unico removido em tb_usuarios.email: ${row.INDEX_NAME}`);
    }
}





// ### CONFIGURAÇÕES GERAIS ### 
// engine de template de visualização
app.engine('handlebars', engine({
    defaultLayout: 'main',
    partialsDir: [path.join(__dirname, 'views', 'layouts')]
}));
app.set('view engine', 'handlebars');


// execução do servidor
const PORT = process.env.ENV_PORT || 3000;
ensureUsuarioEmailNotUnique()
    .then(() => {
        app.listen(PORT, function() {
            console.clear();
            console.log('Servidor funcionando...');
            console.log(`Acesse http://localhost:${PORT} para ver o app.`);
        });
    })
    .catch((err) => {
        console.error('Falha ao inicializar ajuste de indice de e-mail:', err.message);
        process.exit(1);
    });


