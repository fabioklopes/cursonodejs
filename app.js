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
const Turma = require('./models/Turma');
const TurmaAluno = require('./models/TurmaAluno');
const { sequelize, Sequelize } = require('./models/db');
const generatedCode = require('./utils/usercode_generator');
const generateClassCode = require('./utils/classcode_generator');

// Usado apenas para o "Esqueci a minha senha"
const crypto = require('crypto');
const nodemailer = require('nodemailer');


const RESET_TOKEN_TTL_MINUTES = 10;
const RESET_TOKEN_TTL_MS = RESET_TOKEN_TTL_MINUTES * 60 * 1000;
const MOTIVATIONAL_PHRASES_PATH = path.join(__dirname, 'utils', 'frases_motivacionais.txt');




// configuração gerais da aplicação / momento de execução
function loadMotivationalPhrases() {
    try {
        return fs.readFileSync(MOTIVATIONAL_PHRASES_PATH, 'utf8')
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);
    } catch (err) {
        console.error('Erro ao carregar frases motivacionais:', err);
        return [];
    }
}

const motivationalPhrases = loadMotivationalPhrases();

function getRandomMotivationalMessage() {
    if (motivationalPhrases.length === 0) {
        return '';
    }

    const randomIndex = Math.floor(Math.random() * motivationalPhrases.length);
    return motivationalPhrases[randomIndex];
}

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

app.use((req, res, next) => {
    res.locals.birthdayLoginModal = req.session.birthdayLoginModal || null;
    res.locals.motivationalMessage = req.session.motivationalMessage || '';

    if (req.session.birthdayLoginModal) {
        delete req.session.birthdayLoginModal;
    }

    next();
});

// Rotas isentas de verificação de login
function isPublicRoute(pathname) {
    return pathname === '/auth/login'
        || pathname === '/auth/verify'
        || pathname === '/auth/forgot-password'
        || pathname === '/auth/reset-password'
        || pathname === '/reset-password'
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

function normalizeClassName(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function tokenizeClassName(value) {
    const stopWords = new Set(['a', 'o', 'e', 'de', 'da', 'do', 'das', 'dos']);
    return normalizeClassName(value)
        .split(/\s+/)
        .filter((token) => token && !stopWords.has(token));
}

function levenshteinDistance(a, b) {
    const aLen = a.length;
    const bLen = b.length;

    if (aLen === 0) return bLen;
    if (bLen === 0) return aLen;

    const matrix = Array.from({ length: aLen + 1 }, () => new Array(bLen + 1).fill(0));

    for (let i = 0; i <= aLen; i++) matrix[i][0] = i;
    for (let j = 0; j <= bLen; j++) matrix[0][j] = j;

    for (let i = 1; i <= aLen; i++) {
        for (let j = 1; j <= bLen; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            matrix[i][j] = Math.min(
                matrix[i - 1][j] + 1,
                matrix[i][j - 1] + 1,
                matrix[i - 1][j - 1] + cost
            );
        }
    }

    return matrix[aLen][bLen];
}

function areClassNamesTooSimilar(nameA, nameB) {
    const tokensA = tokenizeClassName(nameA);
    const tokensB = tokenizeClassName(nameB);

    if (tokensA.length === 0 || tokensB.length === 0) {
        return false;
    }

    const sortedA = [...tokensA].sort().join(' ');
    const sortedB = [...tokensB].sort().join(' ');
    if (sortedA === sortedB) {
        return true;
    }

    const compactA = tokensA.join('');
    const compactB = tokensB.join('');
    if (compactA === compactB || compactA.includes(compactB) || compactB.includes(compactA)) {
        return true;
    }

    const distance = levenshteinDistance(compactA, compactB);
    const maxLen = Math.max(compactA.length, compactB.length);
    const similarity = maxLen === 0 ? 1 : 1 - (distance / maxLen);
    return similarity >= 0.82;
}

async function generateUniqueClassCode() {
    const maxAttempts = 40;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const classCode = generateClassCode(5);
        const existing = await Turma.findOne({ where: { class_code: classCode } });
        if (!existing) {
            return classCode;
        }
    }

    throw new Error('Nao foi possivel gerar um codigo unico para a turma. Tente novamente.');
}

async function getActiveTurmasOptions(selectedClassCode = '') {
    const turmas = await Turma.findAll({
        where: { active: 'Y' },
        attributes: ['class_code', 'class_name'],
        order: [['class_name', 'ASC']]
    });

    return turmas.map((turma) => {
        const plain = turma.get({ plain: true });
        return {
            ...plain,
            selected: plain.class_code === selectedClassCode
        };
    });
}

async function getActiveTurmasForUser(userCode) {
    if (!userCode) {
        return [];
    }

    const vinculos = await TurmaAluno.findAll({
        where: {
            user_code: userCode,
            active: 'Y'
        },
        attributes: ['class_code']
    });

    const classCodes = [...new Set(vinculos.map((item) => item.class_code).filter(Boolean))];
    if (classCodes.length === 0) {
        return [];
    }

    const turmas = await Turma.findAll({
        where: {
            active: 'Y',
            class_code: { [Op.in]: classCodes }
        },
        attributes: ['class_code', 'class_name'],
        order: [['class_name', 'ASC']]
    });

    return turmas.map((turma) => turma.get({ plain: true }));
}

function normalizeEmail(value) {
    return String(value || '').trim().toLowerCase();
}

function getResetPasswordBaseUrl(req) {
    const configuredBaseUrl = process.env.APP_BASE_URL || process.env.PUBLIC_APP_URL;
    if (configuredBaseUrl) {
        return configuredBaseUrl.replace(/\/$/, '');
    }

    return `${req.protocol}://${req.get('host')}`;
}

function buildResetPasswordLink(req, email, token) {
    const params = new URLSearchParams({
        email,
        token
    });

    return `${getResetPasswordBaseUrl(req)}/auth/reset-password?${params.toString()}`;
}

function getPasswordResetTransportConfig() {
    const service = process.env.SMTP_SERVICE || process.env.EMAIL_SERVICE;
    const host = process.env.SMTP_HOST || process.env.EMAIL_HOST;
    const portValue = process.env.SMTP_PORT || process.env.EMAIL_PORT;
    const user = process.env.SMTP_USER || process.env.EMAIL_USER;
    const pass = process.env.SMTP_PASS || process.env.EMAIL_PASS || process.env.EMAIL_PASSWORD;

    if (!user || !pass || (!service && !host)) {
        return null;
    }

    const port = portValue ? parseInt(portValue, 10) : undefined;
    const secureSetting = process.env.SMTP_SECURE || process.env.EMAIL_SECURE;
    const secure = typeof secureSetting === 'string'
        ? secureSetting.toLowerCase() === 'true'
        : port === 465;

    const transportConfig = {
        auth: { user, pass }
    };

    if (service) {
        transportConfig.service = service;
    } else {
        transportConfig.host = host;
        transportConfig.port = Number.isInteger(port) ? port : 587;
        transportConfig.secure = secure;
    }

    return transportConfig;
}

function buildForgotPasswordMessages(options) {
    const messages = [];

    if (typeof options.emailFound === 'boolean') {
        if (options.emailFound) {
            messages.push({
                variant: 'success',
                title: 'E-mail localizado',
                text: 'Encontramos cadastro(s) vinculado(s) ao e-mail informado.'
            });
        } else {
            messages.push({
                variant: 'warning',
                title: 'E-mail não localizado',
                text: 'Não encontramos esse e-mail em nossa base de dados.'
            });
        }
    }

    if (typeof options.deliveryStatus === 'string') {
        if (options.deliveryStatus === 'sent') {
            messages.push({
                variant: 'success',
                title: 'Mensagem enviada',
                text: 'Enviamos a mensagem de redefinição para o e-mail informado.'
            });
        } else if (options.deliveryStatus === 'preview') {
            messages.push({
                variant: 'info',
                title: 'Mensagem não enviada',
                text: 'O envio de e-mail não está configurado neste ambiente. Para teste local, use o link de redefinição exibido abaixo.'
            });
        } else if (options.deliveryStatus === 'not_found') {
            messages.push({
                variant: 'secondary',
                title: 'Mensagem não enviada',
                text: 'Nenhuma mensagem foi enviada porque o e-mail informado não foi encontrado.'
            });
        } else {
            messages.push({
                variant: 'warning',
                title: 'Mensagem não enviada',
                text: 'Não foi possível enviar a mensagem de redefinição neste momento. Tente novamente em instantes.'
            });
        }
    }

    if (options.hasDuplicateEmail) {
        messages.push({
            variant: 'info',
            title: 'Cadastros vinculados ao mesmo e-mail',
            text: 'A nova senha definida pelo link será aplicada a todos os registros associados a este e-mail.'
        });
    }

    if (options.errorMessage) {
        messages.push({
            variant: 'danger',
            title: 'Não foi possível concluir a solicitação',
            text: options.errorMessage
        });
    }

    messages.push({
        variant: 'info',
        title: 'Prazo do link',
        text: `O link de redefinição pode ser usado por apenas ${RESET_TOKEN_TTL_MINUTES} minutos. Depois disso, será necessário fazer uma nova solicitação.`
    });

    return messages;
}

function buildForgotPasswordAcknowledgementMessage() {
    return [
        {
            variant: 'primary',
            paragraphs: [
                'Se o e-mail informado existir no nosso banco de dados, uma mensagem será enviada com um link para a redefinição da senha.',
                'O prazo para utilização do link é de 10 minutos.',
                'Após o uso ou após o período, o link será inutilizado e será necessário fazer uma nova solicitação.'
            ]
        }
    ];
}

function buildResetPasswordMessages(options) {
    const messages = [];

    if (options.successMessage) {
        messages.push({
            variant: 'success',
            title: 'Senha redefinida',
            text: options.successMessage
        });
    }

    if (options.errorMessage) {
        messages.push({
            variant: 'danger',
            title: 'Link inválido ou expirado',
            text: options.errorMessage
        });
    }

    if (options.infoMessage) {
        messages.push({
            variant: 'info',
            title: 'Importante',
            text: options.infoMessage
        });
    }

    return messages;
}

function renderForgotPasswordPage(res, overrides = {}) {
    const email = typeof overrides.email === 'string' ? overrides.email : '';

    return res.render('resetpassword', {
        pageTitle: overrides.pageTitle || 'Redefinição de Senha',
        email,
        requestMode: overrides.requestMode !== false,
        resetMode: !!overrides.resetMode,
        resetCompleted: !!overrides.resetCompleted,
        statusMessages: overrides.statusMessages || [],
        token: overrides.token || '',
        previewResetLink: overrides.previewResetLink || '',
        previewResetMessage: overrides.previewResetMessage || '',
        canSubmitReset: overrides.canSubmitReset !== false,
        showBackToLogin: overrides.showBackToLogin !== false
    });
}

async function sendResetPasswordEmail(req, email, token, totalUsuarios) {
    const resetLink = buildResetPasswordLink(req, email, token);
    const transportConfig = getPasswordResetTransportConfig();
    if (!transportConfig) {
        return {
            deliveryStatus: 'preview',
            resetLink
        };
    }

    const transporter = nodemailer.createTransport(transportConfig);
    const from = process.env.SMTP_FROM || process.env.EMAIL_FROM || transportConfig.auth.user;
    const pluralLabel = totalUsuarios > 1 ? 'cadastros' : 'cadastro';

    await transporter.sendMail({
        from,
        to: email,
        subject: 'Redefinição de senha',
        text: [
            'Recebemos uma solicitação para redefinir sua senha.',
            '',
            `Este link ficará disponível por ${RESET_TOKEN_TTL_MINUTES} minutos:`,
            resetLink,
            '',
            totalUsuarios > 1
                ? `A nova senha será aplicada a todos os ${pluralLabel} vinculados a este e-mail.`
                : `A nova senha será aplicada ao ${pluralLabel} vinculado a este e-mail.`,
            '',
            'Se você não fez essa solicitação, ignore esta mensagem.'
        ].join('\n'),
        html: `
            <div style="font-family: Arial, sans-serif; line-height: 1.5; color: #212529;">
                <h2 style="margin-bottom: 16px;">Redefinição de senha</h2>
                <p>Recebemos uma solicitação para redefinir sua senha.</p>
                <p>Use o link abaixo em até <strong>${RESET_TOKEN_TTL_MINUTES} minutos</strong>:</p>
                <p><a href="${resetLink}">${resetLink}</a></p>
                <p>${totalUsuarios > 1
                ? 'A nova senha será aplicada a todos os cadastros vinculados a este e-mail.'
                : 'A nova senha será aplicada ao cadastro vinculado a este e-mail.'}</p>
                <p>Se você não fez essa solicitação, ignore esta mensagem.</p>
            </div>
        `
    });

    return {
        deliveryStatus: 'sent',
        resetLink
    };
}

async function findUsuariosByEmail(email) {
    return Usuario.findAll({
        where: { email },
        order: [['id', 'ASC']]
    });
}

async function findUsuariosWithValidResetToken(email, token) {
    const usuarios = await findUsuariosByEmail(email);
    const now = new Date();
    const validUsuarios = [];

    for (const usuario of usuarios) {
        if (!usuario.reset_token_hash || !usuario.reset_token_expires) {
            continue;
        }

        if (new Date(usuario.reset_token_expires) < now) {
            continue;
        }

        const tokenValido = await argon2.verify(usuario.reset_token_hash, token);
        if (tokenValido) {
            validUsuarios.push(usuario);
        }
    }

    return validUsuarios;
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

const BIRTHDAY_MESSAGE_FILE_CANDIDATES = [
    path.join(__dirname, 'utils', 'frases_aniversariantes.txt'),
    path.join(__dirname, 'utils', 'frases_aniversario.txt')
];

const DEFAULT_BIRTHDAY_LEAD_MESSAGES = [
    'Seu aniversário está chegando. Que estes próximos dias sejam leves e especiais.',
    'Mais um passo para celebrar sua jornada. Que seu novo ciclo venha com paz e boas conquistas.',
    'A contagem regressiva começou. Que seu coração se encha de alegria a cada novo dia.',
    'Falta pouco para o seu aniversário. Que este tempo seja de gratidão e bons encontros.',
    'Amanhã é o seu grande dia. Que você receba carinho, paz e muitas alegrias.'
];

const BIRTHDAY_CELEBRATION_MODAL = {
    title: '🎈 FELIZ ANIVERSÁRIO! 🎈',
    bodyHtml: 'Que você tenha muita saúde, paz, prosperidade e que todos os seus desejos se transformem em vitórias e conquistas.<br><br>✨<br><b>Curta seu dia!</b>'
};

const MONTH_NAMES_PT_BR = [
    'Janeiro',
    'Fevereiro',
    'Março',
    'Abril',
    'Maio',
    'Junho',
    'Julho',
    'Agosto',
    'Setembro',
    'Outubro',
    'Novembro',
    'Dezembro'
];

function loadBirthdayLeadMessages() {
    for (const filePath of BIRTHDAY_MESSAGE_FILE_CANDIDATES) {
        try {
            if (!fs.existsSync(filePath)) {
                continue;
            }

            const fileContent = fs.readFileSync(filePath, 'utf8');
            const messages = fileContent
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter(Boolean);

            if (messages.length > 0) {
                return messages;
            }
        } catch (error) {
            console.error('Erro ao carregar mensagens de aniversario:', error.message);
        }
    }

    return DEFAULT_BIRTHDAY_LEAD_MESSAGES;
}

const BIRTHDAY_LEAD_MESSAGES = loadBirthdayLeadMessages();

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

function parseBirthDateParts(birthDateValue) {
    const iso = String(birthDateValue || '').slice(0, 10);
    const match = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) {
        return null;
    }

    const year = parseInt(match[1], 10);
    const month = parseInt(match[2], 10);
    const day = parseInt(match[3], 10);

    if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
        return null;
    }

    if (month < 1 || month > 12 || day < 1 || day > 31) {
        return null;
    }

    return { year, month, day };
}

function calculateAgeFromBirthDateParts(parts, todayDate = new Date()) {
    if (!parts) {
        return 0;
    }

    const todayYear = todayDate.getFullYear();
    const todayMonth = todayDate.getMonth() + 1;
    const todayDay = todayDate.getDate();

    let age = todayYear - parts.year;
    const birthdayPassed = todayMonth > parts.month || (todayMonth === parts.month && todayDay >= parts.day);

    if (!birthdayPassed) {
        age -= 1;
    }

    return Math.max(age, 0);
}

function buildBirthdayWidgetData(users = [], todayDate = new Date()) {
    const todayDay = todayDate.getDate();
    const todayMonthIndex = todayDate.getMonth();

    const birthdays = users
        .map((user) => {
            const plain = user.get({ plain: true });
            const birthParts = parseBirthDateParts(plain.birth_date);
            if (!birthParts) {
                return null;
            }

            const fullName = `${plain.first_name || ''} ${plain.last_name || ''}`.trim() || plain.user_code;
            const age = calculateAgeFromBirthDateParts(birthParts, todayDate);
            const beltDisplay = getBeltDisplayData(plain.actual_belt, plain.actual_degree);
            const birthMonthIndex = birthParts.month - 1;
            const birthMonthLabel = MONTH_NAMES_PT_BR[birthMonthIndex] || '-';
            const isToday = birthParts.day === todayDay && birthMonthIndex === todayMonthIndex;

            return {
                user_code: plain.user_code,
                full_name: fullName,
                avatar: plain.photo || '/uploads/users/default.jpg',
                age,
                birth_year: birthParts.year,
                birth_month_index: birthMonthIndex,
                birth_day: birthParts.day,
                birth_month_label: birthMonthLabel,
                birth_short: `${String(birthParts.day).padStart(2, '0')}/${String(birthParts.month).padStart(2, '0')}`,
                birth_full: `${String(birthParts.day).padStart(2, '0')}/${String(birthParts.month).padStart(2, '0')}/${birthParts.year}`,
                is_today: isToday,
                belt_label: beltDisplay.beltLabel,
                degree_label: beltDisplay.degreeLabel,
                belt_summary_label: beltDisplay.summaryLabel,
                belt_image_path: beltDisplay.imagePath
            };
        })
        .filter(Boolean)
        .sort((a, b) => {
            if (a.birth_month_index !== b.birth_month_index) {
                return a.birth_month_index - b.birth_month_index;
            }

            if (a.birth_day !== b.birth_day) {
                return a.birth_day - b.birth_day;
            }

            return a.full_name.localeCompare(b.full_name, 'pt-BR');
        });

    return {
        currentMonth: todayMonthIndex,
        currentMonthLabel: MONTH_NAMES_PT_BR[todayMonthIndex],
        birthdays
    };
}

function buildBirthdayOccurrenceDate(parts, referenceDate = new Date()) {
    if (!parts) {
        return null;
    }

    const referenceYear = referenceDate.getFullYear();
    const candidate = new Date(referenceYear, parts.month - 1, parts.day);

    if (
        referenceDate.getMonth() > candidate.getMonth()
        || (referenceDate.getMonth() === candidate.getMonth() && referenceDate.getDate() > candidate.getDate())
    ) {
        return new Date(referenceYear + 1, parts.month - 1, parts.day);
    }

    return candidate;
}

function getDiffInDays(startDate, endDate) {
    const start = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
    const end = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
    const diffMs = end.getTime() - start.getTime();
    return Math.round(diffMs / 86400000);
}

function getRandomBirthdayLeadMessage() {
    const messages = Array.isArray(BIRTHDAY_LEAD_MESSAGES) && BIRTHDAY_LEAD_MESSAGES.length > 0
        ? BIRTHDAY_LEAD_MESSAGES
        : DEFAULT_BIRTHDAY_LEAD_MESSAGES;

    if (messages.length === 0) {
        return 'Seu aniversário está chegando!';
    }

    const randomIndex = Math.floor(Math.random() * messages.length);
    return messages[randomIndex];
}

function isBirthdayMessagesDisabledForYear(usuario, referenceDate = new Date()) {
    if (!usuario || !usuario.birthday_messages_disabled) {
        return false;
    }

    const currentYear = referenceDate.getFullYear();
    const disabledYear = parseInt(usuario.birthday_messages_disabled_year, 10);
    return Number.isInteger(disabledYear) && disabledYear === currentYear;
}

function buildBirthdayLoginModalData(usuario, todayDate = new Date()) {
    if (!usuario || isBirthdayMessagesDisabledForYear(usuario, todayDate)) {
        return null;
    }

    const birthParts = parseBirthDateParts(usuario.birth_date);
    if (!birthParts) {
        return null;
    }

    const nextBirthday = buildBirthdayOccurrenceDate(birthParts, todayDate);
    if (!nextBirthday) {
        return null;
    }

    const daysUntilBirthday = getDiffInDays(todayDate, nextBirthday);

    if (daysUntilBirthday === 0) {
        return {
            title: BIRTHDAY_CELEBRATION_MODAL.title,
            bodyHtml: BIRTHDAY_CELEBRATION_MODAL.bodyHtml,
            isBirthday: true,
            checkboxLabel: 'não exibir mais as mensagens de aniversário'
        };
    }

    if (daysUntilBirthday < 1 || daysUntilBirthday > 5) {
        return null;
    }

    return {
        title: 'Seu aniversário está chegando!',
        bodyHtml: getRandomBirthdayLeadMessage(),
        isBirthday: false,
        checkboxLabel: 'não exibir mais as mensagens de aniversário'
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

function buildUserFormViewModel(usuario, isEditMode, turmaOptions = []) {
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
            photo: '/uploads/users/default.jpg',
            class_code: ''
        };

    const selectedClassCode = formData.class_code || '';

    return {
        isEditMode,
        title: isEditMode ? 'Editar Aluno' : 'Novo Aluno',
        submitLabel: isEditMode ? 'Salvar alterações' : 'Enviar',
        formAction: isEditMode ? `/aluno/editar/${formData.id}` : '/aluno/cadastrar',
        usuario: formData,
        beltOptions: BELT_OPTIONS.map((option) => ({
            ...option,
            selected: option.value === formData.actual_belt
        })),
        turmaOptions: turmaOptions.map((turma) => ({
            ...turma,
            selected: turma.class_code === selectedClassCode
        }))
    };
}

// ### CONFIGURAÇÃO DAS ROTAS ###
// rota principal
app.get('/', (req, res) => {
    return res.redirect(getDefaultRedirectByRole(req.session.usuario.role));
});

app.get('/dashboard', async (req, res) => {
    try {
        const birthdayUsers = await Usuario.findAll({
            where: {
                role: 'STD',
                user_status: 'A',
                birth_date: {
                    [Op.not]: null
                }
            },
            attributes: [
                'user_code',
                'first_name',
                'last_name',
                'birth_date',
                'photo',
                'actual_belt',
                'actual_degree'
            ],
            order: [['first_name', 'ASC'], ['last_name', 'ASC']]
        });

        const birthdayWidget = buildBirthdayWidgetData(birthdayUsers);

        if (hasProfessorAccess(req.session.usuario)) {
            return res.render('dashboardprofessor', { birthdayWidget });
        }

        return res.render('dashboardaluno', { birthdayWidget });
    } catch (err) {
        console.error('Erro ao carregar dashboard com aniversariantes:', err);

        if (hasProfessorAccess(req.session.usuario)) {
            return res.render('dashboardprofessor', { birthdayWidget: { currentMonth: new Date().getMonth(), currentMonthLabel: MONTH_NAMES_PT_BR[new Date().getMonth()], birthdays: [] } });
        }

        return res.render('dashboardaluno', { birthdayWidget: { currentMonth: new Date().getMonth(), currentMonthLabel: MONTH_NAMES_PT_BR[new Date().getMonth()], birthdays: [] } });
    }
});

app.get('/dashboardaluno', (req, res) => {
    return res.redirect('/dashboard');
});

app.get('/turmas', async (req, res) => {
    if (!hasProfessorAccess(req.session.usuario)) {
        const mensagem = 'Acesso restrito a professor e administrador.';
        return res.redirect(`/dashboard?mensagem=${encodeURIComponent(mensagem)}`);
    }

    try {
        const usuarioSessao = req.session.usuario;
        const turmas = await Turma.findAll({
            where: { active: 'Y' },
            order: [['class_name', 'ASC']]
        });

        const matriculas = await TurmaAluno.findAll({
            where: { active: 'Y' },
            attributes: ['class_code']
        });

        const countByClassCode = matriculas.reduce((acc, item) => {
            const classCode = item.class_code;
            acc[classCode] = (acc[classCode] || 0) + 1;
            return acc;
        }, {});

        const alunos = await Usuario.findAll({
            where: {
                role: 'STD',
                user_status: 'A'
            },
            attributes: ['user_code', 'first_name', 'last_name', 'photo'],
            order: [['first_name', 'ASC'], ['last_name', 'ASC']]
        });

        const turmasVm = turmas.map((turma) => {
            const plain = turma.get({ plain: true });
            const canManage = usuarioSessao.role === 'ADM' || plain.created_by === usuarioSessao.user_code;
            return {
                ...plain,
                canManage,
                enrolled_count: countByClassCode[plain.class_code] || 0
            };
        });

        const alunosVm = alunos.map((aluno) => {
            const plain = aluno.get({ plain: true });
            return {
                ...plain,
                full_name: `${plain.first_name || ''} ${plain.last_name || ''}`.trim() || plain.user_code,
                avatar: plain.photo || '/uploads/users/default.jpg'
            };
        });

        const matriculasDetalhadas = await TurmaAluno.findAll({
            where: { active: 'Y' },
            attributes: ['class_code', 'user_code']
        });

        const userCodesMatriculados = [...new Set(matriculasDetalhadas.map((item) => item.user_code).filter(Boolean))];
        const alunosMatriculados = userCodesMatriculados.length > 0
            ? await Usuario.findAll({
                where: {
                    user_code: { [Op.in]: userCodesMatriculados },
                    role: 'STD',
                    user_status: 'A'
                },
                attributes: ['user_code', 'first_name', 'last_name', 'photo']
            })
            : [];

        const alunoByCode = alunosMatriculados.reduce((acc, item) => {
            const plain = item.get({ plain: true });
            acc[plain.user_code] = {
                user_code: plain.user_code,
                full_name: `${plain.first_name || ''} ${plain.last_name || ''}`.trim() || plain.user_code,
                avatar: plain.photo || '/uploads/users/default.jpg'
            };
            return acc;
        }, {});

        const alunosByTurma = matriculasDetalhadas.reduce((acc, item) => {
            const classCode = item.class_code;
            const aluno = alunoByCode[item.user_code];
            if (!classCode || !aluno) {
                return acc;
            }

            if (!acc[classCode]) {
                acc[classCode] = [];
            }

            acc[classCode].push(aluno);
            return acc;
        }, {});

        Object.keys(alunosByTurma).forEach((classCode) => {
            alunosByTurma[classCode].sort((a, b) => a.full_name.localeCompare(b.full_name, 'pt-BR'));
        });

        return res.render('turmas', {
            mensagem: req.query.mensagem || '',
            tipoMensagem: req.query.tipo || 'info',
            turmas: turmasVm,
            alunos: alunosVm,
            totalAlunosAtivos: alunosVm.length,
            alunosByTurmaJSON: JSON.stringify(alunosByTurma)
        });
    } catch (err) {
        return res.render('turmas', {
            mensagem: 'Erro ao carregar turmas: ' + err.message,
            tipoMensagem: 'danger',
            turmas: [],
            alunos: [],
            totalAlunosAtivos: 0,
            alunosByTurmaJSON: '{}'
        });
    }
});

app.post('/turmas/criar', async (req, res) => {
    if (!hasProfessorAccess(req.session.usuario)) {
        const mensagem = 'Apenas professor ou administrador pode criar turma.';
        return res.redirect(`/turmas?mensagem=${encodeURIComponent(mensagem)}&tipo=danger`);
    }

    try {
        const className = String(req.body.class_name || '').trim();
        if (!className) {
            throw new Error('Informe o nome da turma.');
        }

        const turmasAtivas = await Turma.findAll({
            where: { active: 'Y' },
            attributes: ['class_name']
        });

        const hasVerySimilarName = turmasAtivas.some((turma) => {
            const existingName = turma.class_name;
            return areClassNamesTooSimilar(existingName, className);
        });

        if (hasVerySimilarName) {
            throw new Error('Ja existe turma com nome igual ou muito parecido. Use um nome mais especifico.');
        }

        const classCode = await generateUniqueClassCode();

        await Turma.create({
            class_name: className,
            class_code: classCode,
            created_by: req.session.usuario.user_code,
            active: 'Y'
        });

        const mensagem = 'Turma criada com sucesso.';
        return res.redirect(`/turmas?mensagem=${encodeURIComponent(mensagem)}&tipo=success`);
    } catch (err) {
        const mensagem = err.message || 'Erro ao criar turma.';
        return res.redirect(`/turmas?mensagem=${encodeURIComponent(mensagem)}&tipo=danger`);
    }
});

app.post('/turmas/desativar/:classCode', async (req, res) => {
    if (!hasProfessorAccess(req.session.usuario)) {
        const mensagem = 'Apenas professor ou administrador pode alterar turmas.';
        return res.redirect(`/turmas?mensagem=${encodeURIComponent(mensagem)}&tipo=danger`);
    }

    try {
        const classCode = String(req.params.classCode || '').trim().toUpperCase();
        const turma = await Turma.findOne({ where: { class_code: classCode } });
        if (!turma) {
            throw new Error('Turma nao encontrada.');
        }

        const isAdmin = req.session.usuario.role === 'ADM';
        const isOwner = turma.created_by === req.session.usuario.user_code;

        if (!isAdmin && !isOwner) {
            throw new Error('Voce pode visualizar esta turma, mas nao pode alterar ou excluir.');
        }

        turma.active = 'N';
        await turma.save();

        await TurmaAluno.update(
            { active: 'N' },
            { where: { class_code: classCode } }
        );

        const mensagem = 'Turma desativada com sucesso.';
        return res.redirect(`/turmas?mensagem=${encodeURIComponent(mensagem)}&tipo=success`);
    } catch (err) {
        const mensagem = err.message || 'Erro ao desativar turma.';
        return res.redirect(`/turmas?mensagem=${encodeURIComponent(mensagem)}&tipo=danger`);
    }
});

app.post('/turmas/matricular', async (req, res) => {
    if (!hasProfessorAccess(req.session.usuario)) {
        const mensagem = 'Apenas professor ou administrador pode matricular alunos.';
        return res.redirect(`/turmas?mensagem=${encodeURIComponent(mensagem)}&tipo=danger`);
    }

    try {
        const classCode = String(req.body.class_code || '').trim().toUpperCase();
        const userCodesRaw = Array.isArray(req.body.user_codes)
            ? req.body.user_codes
            : req.body.user_codes
                ? [req.body.user_codes]
                : [];
        const userCodes = [...new Set(userCodesRaw.map((code) => String(code || '').trim().toUpperCase()).filter(Boolean))];

        if (!classCode) {
            throw new Error('Selecione a turma para matricula.');
        }

        if (userCodes.length === 0) {
            throw new Error('Selecione ao menos um aluno para matricular.');
        }

        const turma = await Turma.findOne({ where: { class_code: classCode, active: 'Y' } });
        if (!turma) {
            throw new Error('Turma selecionada nao esta disponivel.');
        }

        const alunos = await Usuario.findAll({
            where: {
                user_code: { [Op.in]: userCodes },
                role: 'STD',
                user_status: 'A'
            },
            attributes: ['user_code']
        });

        if (alunos.length === 0) {
            throw new Error('Nenhum aluno ativo valido foi encontrado para matricula.');
        }

        let matriculados = 0;
        for (const aluno of alunos) {
            const vinculo = await TurmaAluno.findOne({
                where: {
                    class_code: classCode,
                    user_code: aluno.user_code
                }
            });

            if (!vinculo) {
                await TurmaAluno.create({
                    class_code: classCode,
                    user_code: aluno.user_code,
                    active: 'Y',
                    enrolled_by: req.session.usuario.user_code
                });
                matriculados += 1;
                continue;
            }

            if (vinculo.active !== 'Y') {
                vinculo.active = 'Y';
                vinculo.enrolled_by = req.session.usuario.user_code;
                await vinculo.save();
                matriculados += 1;
            }
        }

        await Usuario.update(
            { class_code: classCode },
            { where: { user_code: { [Op.in]: alunos.map((item) => item.user_code) } } }
        );

        const mensagem = `${matriculados} aluno(s) matriculado(s) com sucesso.`;
        return res.redirect(`/turmas?mensagem=${encodeURIComponent(mensagem)}&tipo=success`);
    } catch (err) {
        const mensagem = err.message || 'Erro ao matricular alunos.';
        return res.redirect(`/turmas?mensagem=${encodeURIComponent(mensagem)}&tipo=danger`);
    }
});

app.post('/turmas/remover-alunos', async (req, res) => {
    if (!hasProfessorAccess(req.session.usuario)) {
        const mensagem = 'Apenas professor ou administrador pode remover alunos de turmas.';
        return res.redirect(`/turmas?mensagem=${encodeURIComponent(mensagem)}&tipo=danger`);
    }

    try {
        const classCode = String(req.body.class_code || '').trim().toUpperCase();
        const userCodesRaw = Array.isArray(req.body.user_codes)
            ? req.body.user_codes
            : req.body.user_codes
                ? [req.body.user_codes]
                : [];
        const userCodes = [...new Set(userCodesRaw.map((code) => String(code || '').trim().toUpperCase()).filter(Boolean))];

        if (!classCode) {
            throw new Error('Turma nao informada para remocao.');
        }

        if (userCodes.length === 0) {
            throw new Error('Selecione ao menos um aluno para remover.');
        }

        const turma = await Turma.findOne({ where: { class_code: classCode, active: 'Y' } });
        if (!turma) {
            throw new Error('Turma nao encontrada ou inativa.');
        }

        const isAdmin = req.session.usuario.role === 'ADM';
        const isOwner = turma.created_by === req.session.usuario.user_code;
        if (!isAdmin && !isOwner) {
            throw new Error('Voce pode visualizar esta turma, mas nao pode alterar alunos matriculados.');
        }

        const [affectedRows] = await TurmaAluno.update(
            { active: 'N' },
            {
                where: {
                    class_code: classCode,
                    user_code: { [Op.in]: userCodes },
                    active: 'Y'
                }
            }
        );

        if (affectedRows > 0) {
            await Usuario.update(
                { class_code: null },
                {
                    where: {
                        user_code: { [Op.in]: userCodes },
                        class_code: classCode
                    }
                }
            );
        }

        const mensagem = `${affectedRows} aluno(s) removido(s) da turma com sucesso.`;
        return res.redirect(`/turmas?mensagem=${encodeURIComponent(mensagem)}&tipo=success`);
    } catch (err) {
        const mensagem = err.message || 'Erro ao remover alunos da turma.';
        return res.redirect(`/turmas?mensagem=${encodeURIComponent(mensagem)}&tipo=danger`);
    }
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

app.get('/aluno/novo', async (req, res) => {
    try {
        const turmaOptions = await getActiveTurmasOptions();
        const vm = buildUserFormViewModel(null, false, turmaOptions);

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

        return res.render('formnovousuario', vm);
    } catch (err) {
        return res.render('formnovousuario', {
            ...buildUserFormViewModel(null, false, []),
            mensagem: 'Erro ao carregar formulario: ' + err.message,
            tipoMensagem: 'erro'
        });
    }
});

app.post('/aluno/cadastrar', upload.single('photo'), async (req, res) => {
    // Função para renderizar o formulário com dados preservados em caso de erro
    const renderFormWithError = async (errorMessage, fieldErrors = {}) => {
        const responsibleId = req.body.responsible_id ? parseInt(req.body.responsible_id, 10) : null;
        const turmaOptions = await getActiveTurmasOptions(req.body.class_code || '');

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
            responsible_id: responsibleId,
            class_code: req.body.class_code || ''
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
            turmaOptions,
            mensagem: errorMessage,
            tipoMensagem: 'erro',
            camposErro: fieldErrors
        };

        res.render('formnovousuario', vm);
    };

    try {
        const responsibleId = req.body.responsible_id ? parseInt(req.body.responsible_id, 10) : null;
        const isDependent = !!responsibleId;
        const classCode = String(req.body.class_code || '').trim().toUpperCase();
        let titular = null;
        const beltDegreeValidation = validateBeltAndDegree(req.body.actual_belt, req.body.actual_degree);
        const turmaSelecionada = classCode
            ? await Turma.findOne({ where: { class_code: classCode, active: 'Y' } })
            : null;

        if (!turmaSelecionada) {
            if (req.file) {
                const tempFilePath = path.join(uploadsDir, req.file.filename);
                if (fs.existsSync(tempFilePath)) {
                    await fs.promises.unlink(tempFilePath);
                }
            }
            return renderFormWithError('Selecione uma turma valida para continuar.', { class_code: 'Selecione uma turma valida.' });
        }

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
                return renderFormWithError('Conta titular invalida ou nao encontrada.');
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
            responsible_id: responsibleId || null,
            class_code: classCode
        });

        await TurmaAluno.findOrCreate({
            where: {
                class_code: classCode,
                user_code: usuario.user_code
            },
            defaults: {
                class_code: classCode,
                user_code: usuario.user_code,
                enrolled_by: req.session.usuario ? req.session.usuario.user_code : usuario.user_code,
                active: 'Y'
            }
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

        return renderFormWithError(mensagemGeral, fieldErrors);
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
    Usuario.findByPk(alunoId).then(async function (usuario) {
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
    }).then(function (finalizedPhoto) {
        if (finalizedPhoto) {
            console.log(`Imagem aprovada: ${finalizedPhoto.finalFileName} (${(finalizedPhoto.fileSize / 1024).toFixed(2)}KB)`);
        }

        const mensagem = 'Cadastro aprovado com sucesso.';
        res.redirect(`/aluno?mensagem=${encodeURIComponent(mensagem)}`);
    }).catch(function (err) {
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
        let turmasSolicitacao = [];
        let requiresTurmaSelection = false;
        let defaultClassCode = '';

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

            turmasSolicitacao = await getActiveTurmasForUser(userCode);
            requiresTurmaSelection = turmasSolicitacao.length > 1;
            if (turmasSolicitacao.length === 1) {
                defaultClassCode = turmasSolicitacao[0].class_code;
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
            turmasSolicitacao,
            requiresTurmaSelection,
            defaultClassCode,
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
            turmasSolicitacao: [],
            requiresTurmaSelection: false,
            defaultClassCode: '',
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

        const turmasAluno = await getActiveTurmasForUser(userCode);
        if (turmasAluno.length === 0) {
            return res.json({ ok: false, mensagem: 'Voce nao possui turma ativa para solicitar presenca.' });
        }

        let selectedClassCode = String(req.body.classCode || '').trim().toUpperCase();
        if (turmasAluno.length === 1) {
            selectedClassCode = turmasAluno[0].class_code;
        }

        const turmaPermitida = turmasAluno.some((turma) => turma.class_code === selectedClassCode);
        if (!selectedClassCode || !turmaPermitida) {
            return res.json({ ok: false, mensagem: 'Selecione uma turma valida para a solicitacao.' });
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
                class_type,
                class_code: selectedClassCode
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

app.post('/aniversario/mensagens/desativar', async (req, res) => {
    try {
        const usuarioSessao = req.session.usuario;
        if (!usuarioSessao || !usuarioSessao.id) {
            return res.status(401).json({ ok: false, mensagem: 'Não autenticado.' });
        }

        const usuario = await Usuario.findByPk(usuarioSessao.id);
        if (!usuario) {
            return res.status(404).json({ ok: false, mensagem: 'Usuário não encontrado.' });
        }

        usuario.birthday_messages_disabled = true;
        usuario.birthday_messages_disabled_year = new Date().getFullYear();
        await usuario.save();
        delete req.session.birthdayLoginModal;

        return res.json({ ok: true });
    } catch (err) {
        return res.status(500).json({ ok: false, mensagem: 'Erro ao atualizar preferência: ' + err.message });
    }
});


// GRUPO DE ROTAS DE AUTENTICAÇÃO / RESET PASSWORD
app.get('/auth/login', function (req, res) {
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
app.post('/auth/verify', function (req, res) {
    const { email, password } = req.body;
    const requestedRedirect = typeof req.body.redirect === 'string' && req.body.redirect.startsWith('/')
        ? req.body.redirect
        : '/dashboard';

    if (!email || !password) {
        const erro = encodeURIComponent('Informe e-mail e senha.');
        return res.redirect(`/auth/login?erro=${erro}&redirect=${encodeURIComponent(requestedRedirect)}`);
    }

    Usuario.findAll({ where: { email: (email || '').trim().toLowerCase() } }).then(async function (usuarios) {
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

        req.session.birthdayLoginModal = buildBirthdayLoginModalData(usuario);
        req.session.motivationalMessage = getRandomMotivationalMessage();

        const redirect = requestedRedirect === '/aluno' || requestedRedirect === '/dashboardaluno'
            ? getDefaultRedirectByRole(usuario.role)
            : requestedRedirect;

        return res.redirect(redirect);
    }).catch(function (err) {
        const erro = encodeURIComponent('Erro ao verificar credenciais: ' + err.message);
        res.redirect(`/auth/login?erro=${erro}&redirect=${encodeURIComponent(requestedRedirect)}`);
    });
});
app.post('/auth/logout', function (req, res) {
    req.session.destroy(function () {
        res.clearCookie('oss.sid');
        const erro = encodeURIComponent('Sessão encerrada. Faça login novamente.');
        res.redirect(`/auth/login?erro=${erro}`);
    });
});

app.get('/auth/forgot-password', (req, res) => {
    renderForgotPasswordPage(res);
});

app.post('/auth/forgot-password', async (req, res) => {
    const email = normalizeEmail(req.body.email);

    if (!email) {
        return renderForgotPasswordPage(res, {
            email,
            statusMessages: buildForgotPasswordMessages({
                errorMessage: 'Informe o e-mail cadastrado para continuar.'
            })
        });
    }

    try {
        const usuarios = await findUsuariosByEmail(email);
        const emailFound = usuarios.length > 0;

        if (emailFound) {
            const token = crypto.randomBytes(32).toString('hex');
            const tokenHash = await argon2.hash(token);
            const reset_token_expires = new Date(Date.now() + RESET_TOKEN_TTL_MS);
            const usuarioIds = usuarios.map((usuario) => usuario.id);

            await Usuario.update(
                { reset_token_hash: tokenHash, reset_token_expires },
                {
                    where: {
                        id: { [Op.in]: usuarioIds }
                    }
                }
            );

            try {
                await sendResetPasswordEmail(req, email, token, usuarios.length);
            } catch (mailError) {
                console.error('Falha ao enviar e-mail de redefinição:', mailError.message);
            }
        }

        return renderForgotPasswordPage(res, {
            requestMode: false,
            email: '',
            statusMessages: buildForgotPasswordAcknowledgementMessage()
        });
    } catch (error) {
        console.error('Erro ao processar solicitação de redefinição:', error);
        return renderForgotPasswordPage(res, {
            requestMode: false,
            email: '',
            statusMessages: buildForgotPasswordAcknowledgementMessage()
        });
    }
});

app.get('/auth/reset-password', async (req, res) => {
    const email = normalizeEmail(req.query.email);
    const token = typeof req.query.token === 'string' ? req.query.token.trim() : '';

    if (!email || !token) {
        return renderForgotPasswordPage(res, {
            requestMode: false,
            resetMode: true,
            canSubmitReset: false,
            email,
            token,
            statusMessages: buildResetPasswordMessages({
                errorMessage: 'O link de redefinição está incompleto. Solicite um novo link para continuar.',
                infoMessage: `Os links de redefinição expiram em ${RESET_TOKEN_TTL_MINUTES} minutos.`
            })
        });
    }

    try {
        const validUsuarios = await findUsuariosWithValidResetToken(email, token);
        if (validUsuarios.length === 0) {
            return renderForgotPasswordPage(res, {
                requestMode: false,
                resetMode: true,
                canSubmitReset: false,
                email,
                token,
                statusMessages: buildResetPasswordMessages({
                    errorMessage: 'Este link é inválido ou já expirou. Faça uma nova solicitação de redefinição.',
                    infoMessage: `Os links de redefinição expiram em ${RESET_TOKEN_TTL_MINUTES} minutos.`
                })
            });
        }

        return renderForgotPasswordPage(res, {
            requestMode: false,
            resetMode: true,
            email,
            token,
            statusMessages: buildResetPasswordMessages({
                infoMessage: validUsuarios.length > 1
                    ? 'A senha que você definir agora será aplicada a todos os cadastros vinculados a este e-mail.'
                    : `Defina sua nova senha. Este link expira em ${RESET_TOKEN_TTL_MINUTES} minutos.`
            })
        });
    } catch (error) {
        console.error('Erro ao validar link de redefinição:', error);
        return renderForgotPasswordPage(res, {
            requestMode: false,
            resetMode: true,
            canSubmitReset: false,
            email,
            token,
            statusMessages: buildResetPasswordMessages({
                errorMessage: 'Não foi possível validar este link agora. Solicite uma nova redefinição.',
                infoMessage: `Os links de redefinição expiram em ${RESET_TOKEN_TTL_MINUTES} minutos.`
            })
        });
    }
});

async function handleResetPasswordSubmit(req, res) {
    const email = normalizeEmail(req.body.email);
    const token = typeof req.body.token === 'string' ? req.body.token.trim() : '';
    const newPassword = String(req.body.newPassword || '').trim();
    const confirmPassword = String(req.body.confirmPassword || '').trim();

    if (!email || !token) {
        return renderForgotPasswordPage(res, {
            requestMode: false,
            resetMode: true,
            canSubmitReset: false,
            email,
            token,
            statusMessages: buildResetPasswordMessages({
                errorMessage: 'O link de redefinição é inválido. Solicite um novo link para continuar.',
                infoMessage: `Os links de redefinição expiram em ${RESET_TOKEN_TTL_MINUTES} minutos.`
            })
        });
    }

    if (!newPassword) {
        return renderForgotPasswordPage(res, {
            requestMode: false,
            resetMode: true,
            email,
            token,
            statusMessages: buildResetPasswordMessages({
                errorMessage: 'Informe a nova senha para concluir a redefinição.',
                infoMessage: `Os links de redefinição expiram em ${RESET_TOKEN_TTL_MINUTES} minutos.`
            })
        });
    }

    if (newPassword.length < 6) {
        return renderForgotPasswordPage(res, {
            requestMode: false,
            resetMode: true,
            email,
            token,
            statusMessages: buildResetPasswordMessages({
                errorMessage: 'A nova senha precisa ter pelo menos 6 caracteres.',
                infoMessage: `Os links de redefinição expiram em ${RESET_TOKEN_TTL_MINUTES} minutos.`
            })
        });
    }

    if (confirmPassword && newPassword !== confirmPassword) {
        return renderForgotPasswordPage(res, {
            requestMode: false,
            resetMode: true,
            email,
            token,
            statusMessages: buildResetPasswordMessages({
                errorMessage: 'A confirmação da senha não confere.',
                infoMessage: `Os links de redefinição expiram em ${RESET_TOKEN_TTL_MINUTES} minutos.`
            })
        });
    }

    try {
        const validUsuarios = await findUsuariosWithValidResetToken(email, token);
        if (validUsuarios.length === 0) {
            return renderForgotPasswordPage(res, {
                requestMode: false,
                resetMode: true,
                canSubmitReset: false,
                email,
                token,
                statusMessages: buildResetPasswordMessages({
                    errorMessage: 'Este link é inválido ou já expirou. Solicite uma nova redefinição.',
                    infoMessage: `Os links de redefinição expiram em ${RESET_TOKEN_TTL_MINUTES} minutos.`
                })
            });
        }

        const newHash = await argon2.hash(newPassword);
        const validIds = validUsuarios.map((usuario) => usuario.id);

        await Usuario.update(
            {
                password: newHash,
                reset_token_hash: null,
                reset_token_expires: null
            },
            {
                where: {
                    id: { [Op.in]: validIds }
                }
            }
        );

        return renderForgotPasswordPage(res, {
            requestMode: false,
            resetMode: true,
            resetCompleted: true,
            canSubmitReset: false,
            email,
            statusMessages: buildResetPasswordMessages({
                successMessage: validUsuarios.length > 1
                    ? 'Sua senha foi redefinida com sucesso em todos os cadastros vinculados a este e-mail.'
                    : 'Sua senha foi redefinida com sucesso.',
                infoMessage: 'Se precisar, você já pode voltar ao login e acessar o sistema com a nova senha.'
            })
        });
    } catch (error) {
        console.error('Erro ao redefinir senha:', error);
        return renderForgotPasswordPage(res, {
            requestMode: false,
            resetMode: true,
            email,
            token,
            statusMessages: buildResetPasswordMessages({
                errorMessage: 'Ocorreu um erro ao redefinir a senha. Solicite um novo link e tente novamente.',
                infoMessage: `Os links de redefinição expiram em ${RESET_TOKEN_TTL_MINUTES} minutos.`
            })
        });
    }
}

app.post('/auth/reset-password', handleResetPasswordSubmit);

// Compatibilidade com formulários antigos
app.post('/reset-password', handleResetPasswordSubmit);

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

async function ensureUsuarioClassCodeColumn() {
    const queryInterface = sequelize.getQueryInterface();
    const tableDescription = await queryInterface.describeTable('tb_usuarios');

    if (!tableDescription.class_code) {
        await queryInterface.addColumn('tb_usuarios', 'class_code', {
            type: Sequelize.STRING(5),
            allowNull: true
        });
        console.log('Coluna class_code adicionada em tb_usuarios.');
    }
}

async function ensureUsuarioBirthdayMessagesDisabledColumn() {
    const queryInterface = sequelize.getQueryInterface();
    const tableDescription = await queryInterface.describeTable('tb_usuarios');

    if (!tableDescription.birthday_messages_disabled) {
        await queryInterface.addColumn('tb_usuarios', 'birthday_messages_disabled', {
            type: Sequelize.BOOLEAN,
            allowNull: false,
            defaultValue: false
        });
        console.log('Coluna birthday_messages_disabled adicionada em tb_usuarios.');
    }
}

async function ensureUsuarioBirthdayMessagesDisabledYearColumn() {
    const queryInterface = sequelize.getQueryInterface();
    const tableDescription = await queryInterface.describeTable('tb_usuarios');

    if (!tableDescription.birthday_messages_disabled_year) {
        await queryInterface.addColumn('tb_usuarios', 'birthday_messages_disabled_year', {
            type: Sequelize.INTEGER,
            allowNull: true
        });
        console.log('Coluna birthday_messages_disabled_year adicionada em tb_usuarios.');
    }

    await queryInterface.bulkUpdate(
        'tb_usuarios',
        { birthday_messages_disabled_year: new Date().getFullYear() },
        {
            birthday_messages_disabled: true,
            birthday_messages_disabled_year: null
        }
    );
}

async function ensureTurmaSchema() {
    await Turma.sync();
    await TurmaAluno.sync();
    await ensureUsuarioClassCodeColumn();
    await ensureUsuarioBirthdayMessagesDisabledColumn();
    await ensureUsuarioBirthdayMessagesDisabledYearColumn();
}





// ### CONFIGURAÇÕES GERAIS ### 
// engine de template de visualização
app.engine('handlebars', engine({
    defaultLayout: 'main',
    partialsDir: [path.join(__dirname, 'views', 'layouts')]
}));

app.set('view engine', 'handlebars');

app.set('views', path.join(__dirname, 'views'));

// execução do servidor
const PORT = process.env.ENV_PORT || 3000;
ensureUsuarioEmailNotUnique()
    .then(() => {
        return ensureTurmaSchema();
    })
    .then(() => {
        app.listen(PORT, function () {
            console.clear();
            console.log('Servidor funcionando...');
            console.log(`Acesse http://localhost:${PORT} para ver o app.`);
        });
    })
    .catch((err) => {
        console.error('Falha ao inicializar ajuste de indice de e-mail:', err.message);
        process.exit(1);
    });


