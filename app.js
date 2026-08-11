/**
 * ============================================================================
 * SISTEMA OSS — Aplicação principal (Express)
 * ============================================================================
 *
 * Portal web de gestão de academia de Jiu-jitsu.
 *
 * Este arquivo concentra:
 *   - Registro de middlewares globais
 *   - Quase todas as rotas HTTP (turmas, alunos, presença, relatórios, etc.)
 *   - Funções auxiliares de negócio (faixas, aniversário, fotos, presença)
 *
 * Rotas de login/logout ficam em routes/auth.js.
 * Lógica reutilizável está em services/ e lib/pure_helpers.js.
 *
 * Papéis de usuário: STD (aluno), PRO (professor), ADM (administrador).
 *
 * Documentação completa: DOCUMENTACAO.md
 * ============================================================================
 */

// Carrega variáveis do arquivo .env (senha do banco, chave de sessão, etc.)
require('dotenv').config();

const express = require('express');
const app = express();
app.set('trust proxy', 1);

const { engine } = require('express-handlebars');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const argon2 = require('argon2');
const { Op, QueryTypes } = require('sequelize');
const moment = require('moment');
const Usuario = require('./models/Usuario');
const Presenca = require('./models/Presenca');
const Turma = require('./models/Turma');
const TurmaAluno = require('./models/TurmaAluno');
const MensagemProfessor = require('./models/MensagemProfessor');
const MensagemProfessorOcultacao = require('./models/MensagemProfessorOcultacao');
const MensagemProfessorLeitura = require('./models/MensagemProfessorLeitura');
const MetaAula = require('./models/MetaAula');
const MetaAulaTurma = require('./models/MetaAulaTurma');
const AppActivityLog = require('./models/AppActivityLog');
const Notificacao = require('./models/Notificacao');
const AtributoAvaliacao = require('./models/AtributoAvaliacao');
const AvatarChangeRequest = require('./models/AvatarChangeRequest');
const { sequelize, Sequelize } = require('./models/db');
const generatedCode = require('./utils/usercode_generator');
const generateClassCode = require('./utils/classcode_generator');
const { validateBrazilMobilePhone } = require('./utils/phone_br');
require('./models/associations');
const { ensureUsuarioEmailNotUnique, ensureTurmaSchema } = require('./bootstrap/ensure_schema');
const { getEffectiveUserCode, normalizeUserCode, notificacaoRecipientCodes } = require('./services/effective_user_code');
const {
    getActiveTurmasForUser,
    expireProfessorMessagesIfNeeded,
    getTurmasDisponiveisParaMensagem,
    toMassMessageViewModel,
    getStudentMassMessageState,
    findVisibleMassMessageForStudent,
    markMassMessageAsRead
} = require('./services/professor_mass_messages');
const { createStudentNavLocalsMiddleware } = require('./middleware/student_nav_locals');
const { createAdminLogLocalsMiddleware } = require('./middleware/admin_log_locals');
const {
    EMAIL_CHANGE_TOKEN_TTL_MS
} = require('./config/constants');
const { getRandomMotivationalMessage } = require('./utils/motivational_phrases');
const {
    hasProfessorAccess,
    buildPaginationVm,
    formatDateBrFromYmd,
    getTodayYmd,
    toDateStartOfDay,
    toDateEndOfDay,
    normalizeNameSortKey,
    buildYmdFromParts,
    getBaseBeltColor,
    getBeltGroupOrderDesc,
    getBeltBadgeClass,
    resolveLocalUploadFile,
    getDefaultRedirectByRole,
    getRoleLabel,
    normalizeClassName,
    tokenizeClassName,
    levenshteinDistance,
    areClassNamesTooSimilar,
    formatDateTimeForInput,
    formatDateTimePtBr,
    formatDateTimePtBrWithAs,
    parseDateTimeInput,
    normalizeEmail,
    normalizePersonName,
    formatLastNameWithConnectives,
    formatPhoneDigitsToBr,
    roleLabelPtBr,
    userStatusLabelPtBr
} = require('./lib/pure_helpers');
const { createActivityLogMiddleware } = require('./middleware/activity_log');
const portalLocalsMiddleware = require('./middleware/portal_locals');
const dependentsMenuMiddleware = require('./middleware/dependents_menu');
const { requireAuth } = require('./middleware/require_auth');
const {
    getErrorViewModel,
    renderErrorPage,
    createClientErrorGuardMiddleware,
    createNotFoundMiddleware,
    createErrorMiddleware
} = require('./middleware/http_errors');
const { registerExpressStack } = require('./config/register_express_stack');
const { ensureProfessorRoute, ensureAdminRoute, ensureRankingRoute } = require('./middleware/authorization');
const { exportStudentsToXlsx, exportStudentsToPdf } = require('./services/student_list_exports');
const { buildFrequenciaRankingPage } = require('./services/ranking_frequencia');
const { getPasswordResetTransportConfig } = require('./services/mail_transport');
const { buildEmailChangeConfirmLink } = require('./services/public_app_links');
const { registerAuthRoutes } = require('./routes/auth');
const {
    createIgnitionMiddleware,
    registerIgnitionRoutes,
    initializeIgnition
} = require('./utils/ignition');
const katasPorFaixaData = require('./utils/katas_por_faixa.json');

// Usado em meuperfil, redefinição de e-mail e fluxos com token
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const isProduction = process.env.NODE_ENV === 'production';
const sessionSecret = process.env.SESSION_SECRET;

if (isProduction && (!sessionSecret || sessionSecret.trim().length < 32)) {
    throw new Error('SESSION_SECRET ausente/curto demais. Defina um valor forte no ambiente de produção.');
}

app.set('env', isProduction ? 'production' : 'development');

registerExpressStack(app, { engine, moment, isProduction, sessionSecret });
app.use(createClientErrorGuardMiddleware({ isProduction }));

app.use(createActivityLogMiddleware());
app.use(portalLocalsMiddleware);
app.use(dependentsMenuMiddleware);

app.use(createStudentNavLocalsMiddleware());
app.use(createAdminLogLocalsMiddleware());

registerIgnitionRoutes(app);
app.use(createIgnitionMiddleware());

app.use(requireAuth);

// ============================================================================
// RELATÓRIOS — preparação de dados de alunos
// ============================================================================

/** Busca todos os alunos do banco e monta os dados formatados para relatórios (nome, faixa, foto, etc.). */
async function fetchAllStudentsForReports() {
    const usuarios = await Usuario.findAll({
        where: { role: 'STD' },
        attributes: ['id', 'user_code', 'first_name', 'last_name', 'photo', 'birth_date', 'actual_belt', 'actual_degree', 'user_status', 'obi_size'],
        order: [['first_name', 'ASC'], ['last_name', 'ASC']]
    });

    return usuarios.map((u) => {
        const plain = u.get({ plain: true });
        const fullName = `${plain.first_name || ''} ${plain.last_name || ''}`.trim() || plain.user_code;
        const beltDisplay = getBeltDisplayData(plain.actual_belt, plain.actual_degree);
        const birthParts = parseBirthDateParts(plain.birth_date);
        const birthYmd = birthParts ? buildYmdFromParts(birthParts) : '';
        return {
            ...plain,
            full_name: fullName,
            sort_key: normalizeNameSortKey(fullName),
            is_active: plain.user_status === 'A',
            photo: plain.photo || '/uploads/users/default.jpg',
            birth_date_ymd: birthYmd,
            birth_date_br: birthYmd ? formatDateBrFromYmd(birthYmd) : '-',
            belt_label: beltDisplay.beltLabel,
            degree_label: beltDisplay.degreeLabel,
            belt_degree_num: beltDisplay.degree,
            belt_summary_label: beltDisplay.summaryLabel,
            belt_image_path: beltDisplay.imagePath,
            belt_group_order_desc: getBeltGroupOrderDesc(plain.actual_belt),
            belt_badge_class: getBeltBadgeClass(plain.actual_belt)
        };
    });
}

/** Gera um código de turma de 5 letras/números que ainda não existe no banco. Tenta até 40 vezes. */
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

/** Lista turmas ativas para usar em selects de formulário. Marca qual está selecionada. */
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

/** Converte uma data para o formato YYYY-MM-DD usado em campos HTML type="date". */
function formatDateForInput(dateValue) {
    if (!dateValue) {
        return '';
    }

    const date = new Date(dateValue);
    if (Number.isNaN(date.getTime())) {
        return '';
    }

    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const KIMONO_WAGI_ZUBON_SIZE_OPTIONS = [
    { code: 'M000', label: 'M000 — 0,90 m a 1,00 m' },
    { code: 'M00', label: 'M00 — 1,00 m a 1,10 m' },
    { code: 'M0', label: 'M0 — 1,10 m a 1,20 m' },
    { code: 'M1', label: 'M1 — 1,20 m a 1,30 m' },
    { code: 'M2', label: 'M2 — 1,30 m a 1,40 m' },
    { code: 'M3', label: 'M3 — 1,40 m a 1,50 m' },
    { code: 'M4', label: 'M4 — 1,50 m a 1,60 m' },
    { code: 'A0', label: 'A0 — 1,55 m a 1,65 m / Até 65 kg' },
    { code: 'A1', label: 'A1 — 1,65 m a 1,75 m / Até 75 kg' },
    { code: 'A2', label: 'A2 — 1,75 m a 1,85 m / Até 85 kg' },
    { code: 'A3', label: 'A3 — 1,85 m a 1,95 m / Até 95 kg' },
    { code: 'A4', label: 'A4 — 1,95 m a 2,05 m / Até 105 kg' },
    { code: 'A5', label: 'A5 — Acima de 2,05 m / Até 120 kg' },
    { code: 'A6', label: 'A6 — Ultra-pesado / Acima de 120 kg' }
];

const OBI_SIZE_OPTIONS = [
    { code: 'M0', label: 'M0 — 1,90 m' },
    { code: 'M1', label: 'M1 — 2,00 m' },
    { code: 'M2', label: 'M2 — 2,10 m' },
    { code: 'M3', label: 'M3 — 2,20 m' },
    { code: 'M4', label: 'M4 — 2,30 m' },
    { code: 'A0', label: 'A0 — 2,45 m' },
    { code: 'A1', label: 'A1 — 2,60 m' },
    { code: 'A2', label: 'A2 — 2,85 m' },
    { code: 'A3', label: 'A3 — 3,00 m' },
    { code: 'A4', label: 'A4 — 3,15 m' },
    { code: 'A5', label: 'A5 — 3,30 m' },
    { code: 'A6', label: 'A6 — 3,45 m' }
];

const KIMONO_SIZE_CODES = new Set(KIMONO_WAGI_ZUBON_SIZE_OPTIONS.map((o) => o.code));
const OBI_SIZE_CODES = new Set(OBI_SIZE_OPTIONS.map((o) => o.code));

/** Retorna o texto legível do tamanho de kimono (wagi/zubon) a partir do código. */
function getKimonoWagiZubonSizeLabel(code) {
    const c = String(code || '').trim();
    const hit = KIMONO_WAGI_ZUBON_SIZE_OPTIONS.find((o) => o.code === c);
    return hit ? hit.label : (c || '—');
}

/** Retorna o texto legível do tamanho do obi (faixa de tecido) a partir do código. */
function getObiSizeOptionLabel(code) {
    const c = String(code || '').trim();
    const hit = OBI_SIZE_OPTIONS.find((o) => o.code === c);
    return hit ? hit.label : (c || '—');
}

/** Envia e-mail com link para o aluno confirmar a troca de endereço de e-mail. */
async function sendProfileEmailChangeConfirmation(req, toEmail, token) {
    const normalized = normalizeEmail(toEmail);
    const link = buildEmailChangeConfirmLink(req, normalized, token);
    const transportConfig = getPasswordResetTransportConfig();
    const bodyIntro = 'Você está recebendo esta mensagem porque informou um novo e-mail para fazer login na aplicação CRTN Belém. Para confirmar a alteração clique no botão abaixo. Caso não tenha solicitado esta ação, basta ignorar esta mensagem.';

    if (!transportConfig) {
        console.info('[meuperfil] Confirmação de e-mail (SMTP não configurado). Link:', link);
        return { deliveryStatus: 'preview', link };
    }

    const transporter = nodemailer.createTransport(transportConfig);
    const from = process.env.SMTP_FROM || process.env.EMAIL_FROM || transportConfig.auth.user;

    await transporter.sendMail({
        from,
        to: normalized,
        subject: 'Confirmar alteração de e-mail — CRTN Belém',
        text: `${bodyIntro}\n\n${link}`,
        html: `
            <div style="font-family: Arial, sans-serif; line-height: 1.5; color: #212529;">
                <p>${bodyIntro}</p>
                <p><a href="${link}">${link}</a></p>
            </div>
        `
    });

    return { deliveryStatus: 'sent', link };
}

/** Retorna o ID do usuário cujo perfil está sendo editado (titular ou dependente em visualização). */
function getEffectiveProfileUserId(req) {
    if (!req.session.usuario) {
        return null;
    }

    if (req.session.viewingAs && req.session.viewingAs.id) {
        return req.session.viewingAs.id;
    }

    return req.session.usuario.id;
}

/** Meu Perfil: aluno (STD), professor (PRO) e administrador (ADM). */
function requireMeuPerfilSession(req, res, next) {
    if (!req.session.usuario) {
        return res.redirect('/auth/login');
    }

    if (!['STD', 'PRO', 'ADM'].includes(req.session.usuario.role)) {
        const mensagem = encodeURIComponent('Nível de acesso não autorizado para esta área.');
        return res.redirect(`/dashboard?mensagem=${mensagem}`);
    }

    return next();
}

const { uploadsDir, upload } = require('./config/multer_user_photo');

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

// ============================================================================
// ANIVERSÁRIO — widget do dashboard e modal no login
// ============================================================================

/** Carrega frases de “seu aniversário está chegando” do arquivo de texto ou usa padrão. */
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

// ============================================================================
// FAIXAS E GRAUS — validação e exibição
// ============================================================================

/** Quantos graus uma faixa pode ter: faixa preta vai até 6, as demais até 4. */
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

/** Monta todos os dados visuais de uma faixa: nome, grau, imagem e texto resumido. */
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
    if (!birthDateValue) {
        return null;
    }

    const isValidCalendarDate = (year, month, day) => {
        if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
            return false;
        }

        if (month < 1 || month > 12 || day < 1 || day > 31) {
            return false;
        }

        const date = new Date(year, month - 1, day);
        return date.getFullYear() === year
            && date.getMonth() === (month - 1)
            && date.getDate() === day;
    };

    let year;
    let month;
    let day;

    if (birthDateValue instanceof Date) {
        if (Number.isNaN(birthDateValue.getTime())) {
            return null;
        }

        // DATEONLY pode chegar como Date em UTC (00:00:00Z).
        // Usamos componentes UTC para evitar regressao de um dia por fuso.
        year = birthDateValue.getUTCFullYear();
        month = birthDateValue.getUTCMonth() + 1;
        day = birthDateValue.getUTCDate();
    } else {
        const normalized = String(birthDateValue || '').trim();
        if (!normalized) {
            return null;
        }

        const isoMatch = normalized.match(/(\d{4})-(\d{2})-(\d{2})/);
        const brMatch = normalized.match(/(\d{2})\/(\d{2})\/(\d{4})/);

        if (isoMatch) {
            year = parseInt(isoMatch[1], 10);
            month = parseInt(isoMatch[2], 10);
            day = parseInt(isoMatch[3], 10);
        } else if (brMatch) {
            day = parseInt(brMatch[1], 10);
            month = parseInt(brMatch[2], 10);
            year = parseInt(brMatch[3], 10);
        } else {
            const parsed = new Date(normalized);
            if (Number.isNaN(parsed.getTime())) {
                return null;
            }

            year = parsed.getFullYear();
            month = parsed.getMonth() + 1;
            day = parsed.getDate();
        }
    }

    if (!isValidCalendarDate(year, month, day)) {
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

/** Monta a lista de aniversariantes do mês para o widget do dashboard. */
function buildBirthdayWidgetData(users = [], todayDate = new Date()) {
    // Usa fuso fixo de Brasília (UTC-3) para garantir o dia civil correto,
    // independente do fuso configurado no servidor (ex: TZ=UTC em cloud/Docker).
    const todayBr = moment(todayDate).utcOffset(PRESENCA_BR_UTC_OFFSET_MIN);
    const todayDay = todayBr.date();
    const todayMonthIndex = todayBr.month();
    const hiddenUserCodes = new Set(['JY5TM', 'PETC5', 'Z5LAX', 'ADMIN']);

    const birthdays = users
        .filter((user) => {
            if (!user || typeof user.get !== 'function') {
                return false;
            }
            const plain = user.get({ plain: true });
            const code = String(plain.user_code || '').trim().toUpperCase();
            return code ? !hiddenUserCodes.has(code) : true;
        })
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

/** Decide se mostra modal de aniversário no login (hoje ou nos próximos 5 dias). */
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

// ============================================================================
// FOTOS DE USUÁRIO — upload, redimensionamento e limpeza
// ============================================================================

/** Redimensiona foto para 500x500 px com qualidade fixa de 80%. Resultado máximo: 2 MB. */
async function optimizeImageTo1MB(inputPath, outputPath) {
    const buffer = await sharp(inputPath)
        .resize(500, 500, {
            fit: 'cover',
            position: 'center'
        })
        .jpeg({ quality: 80, progressive: true })
        .toBuffer();

    await fs.promises.writeFile(outputPath, buffer);
    return buffer.length;
}

/** Apaga a foto final atual do usuário no disco, se houver. */
async function removeExistingUserImage(usuario) {
    if (isTempPhotoPath(usuario.photo)) {
        return;
    }

    const fileName = getFileNameFromPhotoPath(usuario.photo);
    if (!fileName || fileName === 'default.jpg') {
        return;
    }

    const filePath = path.join(uploadsDir, fileName);
    if (fs.existsSync(filePath)) {
        await fs.promises.unlink(filePath);
    }
}

/** Salva a foto definitiva do usuário no disco, nomeada pelo seu user_code. */
async function replaceUserPhoto(usuario, tempFileName) {
    const finalFileName = `${usuario.user_code.toLowerCase()}.jpg`;
    const tempFilePath = path.join(uploadsDir, tempFileName);
    const finalFilePath = path.join(uploadsDir, finalFileName);

    try {
        await removeExistingUserImage(usuario);
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

    if (formData.wagi_size !== undefined && formData.wagi_size !== null) {
        formData.wagi_size = String(formData.wagi_size).trim().toUpperCase();
    }
    if (formData.zubon_size !== undefined && formData.zubon_size !== null) {
        formData.zubon_size = String(formData.zubon_size).trim().toUpperCase();
    }
    if (formData.obi_size !== undefined && formData.obi_size !== null) {
        formData.obi_size = String(formData.obi_size).trim().toUpperCase();
    }

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
        })),
        kimonoSizeOptions: KIMONO_WAGI_ZUBON_SIZE_OPTIONS,
        obiSizeOptions: OBI_SIZE_OPTIONS
    };
}

// ### CONFIGURAÇÃO DAS ROTAS ###
// rota principal
app.get('/', (req, res) => {
    if (!req.session.usuario) {
        return res.redirect('/auth/login');
    }
    return res.redirect(getDefaultRedirectByRole(req.session.usuario.role));
});

app.get('/dashboard', async (req, res) => {
    try {
        const birthdayUsers = await Usuario.findAll({
            where: {
                role: { [Op.in]: ['STD', 'PRO'] },
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
            const pendingStudentCount = await Usuario.count({
                where: {
                    role: 'STD',
                    user_status: 'P'
                }
            });
            const pendingPresencaCount = await Presenca.count({
                where: { status: 'P' }
            });
            const pendingAvatarCount = await AvatarChangeRequest.count();

            return res.render('dashboardprofessor', {
                birthdayWidget,
                pendingStudentCount,
                pendingPresencaCount,
                pendingAvatarCount
            });
        }

        const userCode = await getEffectiveUserCode(req);
        const metaProgress = userCode ? await getCurrentMetaProgressForStudent(userCode) : null;
        return res.render('dashboardaluno', { birthdayWidget, metaProgress });
    } catch (err) {
        console.error('Erro ao carregar dashboard com aniversariantes:', err);

        if (hasProfessorAccess(req.session.usuario)) {
            const pendingStudentCount = await Usuario.count({
                where: {
                    role: 'STD',
                    user_status: 'P'
                }
            });
            const pendingPresencaCount = await Presenca.count({
                where: { status: 'P' }
            });
            const pendingAvatarCount = await AvatarChangeRequest.count();

            return res.render('dashboardprofessor', {
                birthdayWidget: {
                    currentMonth: new Date().getMonth(),
                    currentMonthLabel: MONTH_NAMES_PT_BR[new Date().getMonth()],
                    birthdays: []
                },
                pendingStudentCount,
                pendingPresencaCount,
                pendingAvatarCount
            });
        }

        const userCode = await getEffectiveUserCode(req);
        const metaProgress = userCode ? await getCurrentMetaProgressForStudent(userCode) : null;
        return res.render('dashboardaluno', {
            birthdayWidget: { currentMonth: new Date().getMonth(), currentMonthLabel: MONTH_NAMES_PT_BR[new Date().getMonth()], birthdays: [] },
            metaProgress
        });
    }
});

app.get('/dashboardaluno', (req, res) => {
    return res.redirect('/dashboard');
});

app.get('/mensagens/mestre', async (req, res) => {
    const usuarioSessao = req.session.usuario;
    if (!usuarioSessao || usuarioSessao.role !== 'STD') {
        const mensagem = 'Acesso restrito ao aluno.';
        return res.redirect(`/dashboard?mensagem=${encodeURIComponent(mensagem)}`);
    }

    try {
        const state = await getStudentMassMessageState(usuarioSessao);

        return res.render('mensagensmestre', {
            mensagem: req.query.mensagem || '',
            tipoMensagem: req.query.tipo || 'info',
            mensagens: state.messages,
            totalMensagens: state.totalCount,
            totalNaoLidas: state.unreadCount,
            totalLidas: state.totalCount - state.unreadCount
        });
    } catch (err) {
        return res.render('mensagensmestre', {
            mensagem: 'Erro ao carregar mensagens do mestre: ' + err.message,
            tipoMensagem: 'danger',
            mensagens: [],
            totalMensagens: 0,
            totalNaoLidas: 0,
            totalLidas: 0
        });
    }
});

app.get('/mensagens', async (req, res) => {
    if (!hasProfessorAccess(req.session.usuario)) {
        const mensagem = 'Acesso restrito a professor e administrador.';
        return res.redirect(`/dashboard?mensagem=${encodeURIComponent(mensagem)}`);
    }

    try {
        await expireProfessorMessagesIfNeeded();

        const turmasDisponiveis = await getTurmasDisponiveisParaMensagem(req.session.usuario);
        const turmaByCode = turmasDisponiveis.reduce((acc, turma) => {
            acc[turma.class_code] = turma.class_name;
            return acc;
        }, {});

        const where = {};

        const mensagensAtivas = await MensagemProfessor.findAll({
            where: {
                ...where,
                status: 'A'
            },
            order: [['expires_at', 'ASC']]
        });

        const mensagensExpiradas = await MensagemProfessor.findAll({
            where: {
                ...where,
                status: 'E'
            },
            order: [['createdAt', 'DESC']]
        });

        const mensagensAtivasVm = mensagensAtivas.map((mensagem) => toMassMessageViewModel(mensagem, turmaByCode));
        const mensagensExpiradasVm = mensagensExpiradas.map((mensagem) => toMassMessageViewModel(mensagem, turmaByCode));

        const defaultExpireDate = new Date();
        defaultExpireDate.setDate(defaultExpireDate.getDate() + 7);

        return res.render('mensagens', {
            mensagem: req.query.mensagem || '',
            tipoMensagem: req.query.tipo || 'info',
            mensagensAtivas: mensagensAtivasVm,
            mensagensExpiradas: mensagensExpiradasVm,
            totalMensagens: mensagensAtivasVm.length + mensagensExpiradasVm.length,
            turmas: turmasDisponiveis,
            defaultExpireAt: formatDateTimeForInput(defaultExpireDate)
        });
    } catch (err) {
        return res.render('mensagens', {
            mensagem: 'Erro ao carregar mensagens: ' + err.message,
            tipoMensagem: 'danger',
            mensagensAtivas: [],
            mensagensExpiradas: [],
            totalMensagens: 0,
            turmas: [],
            defaultExpireAt: ''
        });
    }
});

// Allowlist fixa de destinos de retorno após criar uma Meta de Aula (evita open redirect).
const METASDEAULA_RETURN_TO_ALLOWLIST = new Set(['relatorios-presencas']);

app.get('/metasdeaula', async (req, res) => {
    const usuarioSessao = req.session.usuario;
    if (!usuarioSessao) {
        return res.redirect('/dashboard');
    }

    try {
        const isProfessorPage = hasProfessorAccess(usuarioSessao);
        const isStudentPage = usuarioSessao.role === 'STD';
        const returnTo = METASDEAULA_RETURN_TO_ALLOWLIST.has(String(req.query.returnTo || ''))
            ? String(req.query.returnTo)
            : '';

        if (!isProfessorPage && !isStudentPage) {
            const mensagem = 'Acesso restrito ao sistema.';
            return res.redirect(`/dashboard?mensagem=${encodeURIComponent(mensagem)}`);
        }

        if (isProfessorPage) {
            const turmas = await Turma.findAll({ where: { active: 'Y' }, order: [['class_name', 'ASC']] });
            const turmasVm = turmas.map((turma) => turma.get({ plain: true }));

            // PRO tem o mesmo nível de acesso de ADM aqui: vê as metas de todos os professores.
            const metas = await MetaAula.findAll({
                include: [{ model: Turma, as: 'turmas', through: { attributes: [] } }],
                order: [['createdAt', 'DESC']]
            });

            const metasVm = metas.map((meta) => {
                const plain = meta.get({ plain: true });
                const classesLabel = (plain.turmas || []).map((turma) => turma.class_name).join(', ') || '-';
                
                // Formatar datas
                const startDateFormatted = plain.start_date ? new Date(plain.start_date).toLocaleDateString('pt-BR') : '-';
                const endDateFormatted = plain.end_date ? new Date(plain.end_date).toLocaleDateString('pt-BR') : '-';
                const examStartDateFormatted = plain.exam_start_date ? new Date(plain.exam_start_date).toLocaleDateString('pt-BR') : '-';
                const examEndDateFormatted = plain.exam_end_date ? new Date(plain.exam_end_date).toLocaleDateString('pt-BR') : '-';
                
                return {
                    ...plain,
                    classesLabel,
                    start_date: startDateFormatted,
                    end_date: endDateFormatted,
                    exam_start_date: examStartDateFormatted,
                    exam_end_date: examEndDateFormatted,
                    statusLabel: plain.status === 'A' ? 'Ativa' : 'Encerrada'
                };
            });

            return res.render('metasdeaula', {
                mensagem: req.query.mensagem || '',
                tipoMensagem: req.query.tipo || 'info',
                isProfessorPage: true,
                turmas: turmasVm,
                metas: metasVm,
                returnTo
            });
        }

        const turmasAluno = await TurmaAluno.findAll({
            where: { user_code: usuarioSessao.user_code, active: 'Y' },
            attributes: ['class_code']
        });
        const classCodes = [...new Set(turmasAluno.map((item) => item.class_code))].filter(Boolean);

        console.log('=== DEBUG GET /metasdeaula (Aluno) ===');
        console.log('Aluno:', usuarioSessao.user_code, usuarioSessao.first_name);
        console.log('Turmas do aluno:', classCodes);

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        console.log('Data de filtro (today):', today);

        const pageSize = 10;
        const currentPage = Math.max(1, parseInt(req.query.page, 10) || 1);
        const offset = (currentPage - 1) * pageSize;

        let metasResult = { count: 0, rows: [] };
        if (classCodes.length > 0) {
            metasResult = await MetaAula.findAndCountAll({
                where: {
                    status: 'A',
                    end_date: {
                        [Op.gte]: today
                    }
                },
                include: [
                    {
                        model: Turma,
                        as: 'turmas',
                        through: { attributes: [] },
                        where: { class_code: { [Op.in]: classCodes } }
                    },
                    {
                        model: Usuario,
                        as: 'criador',
                        attributes: ['first_name', 'last_name']
                    }
                ],
                order: [['start_date', 'ASC']],
                limit: pageSize,
                offset,
                distinct: true,
                raw: false
            });
        }

        const totalMetas = metasResult.count || 0;
        const totalPages = Math.max(1, Math.ceil(totalMetas / pageSize));
        const currentPageSafe = Math.min(currentPage, totalPages);
        const pageNumbers = totalPages > 1 ? Array.from({ length: totalPages }, (_, index) => index + 1) : [];
        const metas = metasResult.rows || [];

        console.log('Metas encontradas:', totalMetas);
        if (metas.length > 0) {
            console.log('Primeira meta:', metas[0].dataValues);
        }

        const metasVm = metas.map((meta) => {
            const plain = meta.get({ plain: true });
            const classesLabel = (plain.turmas || []).map((turma) => turma.class_name).join(', ') || '-';
            
            // Formatar datas
            const startDateFormatted = plain.start_date ? new Date(plain.start_date).toLocaleDateString('pt-BR') : '-';
            const endDateFormatted = plain.end_date ? new Date(plain.end_date).toLocaleDateString('pt-BR') : '-';
            const examStartDateFormatted = plain.exam_start_date ? new Date(plain.exam_start_date).toLocaleDateString('pt-BR') : '-';
            const examEndDateFormatted = plain.exam_end_date ? new Date(plain.exam_end_date).toLocaleDateString('pt-BR') : '-';

            const totalClasses = Number(plain.total_classes) || 0;
            const minClasses = Number(plain.min_classes) || 0;
            const minClassesPercent =
                totalClasses > 0 ? Math.round((Math.min(minClasses, totalClasses) / totalClasses) * 100) : 0;
            
            return {
                ...plain,
                classesLabel,
                start_date: startDateFormatted,
                end_date: endDateFormatted,
                exam_start_date: examStartDateFormatted,
                exam_end_date: examEndDateFormatted,
                min_classes_percent: minClassesPercent
            };
        });

        return res.render('metasdeaula', {
            mensagem: req.query.mensagem || '',
            tipoMensagem: req.query.tipo || 'info',
            isProfessorPage: false,
            metas: metasVm,
            currentPage: currentPageSafe,
            totalPages,
            pageNumbers,
            prevPage: Math.max(1, currentPageSafe - 1),
            nextPage: Math.min(totalPages, currentPageSafe + 1)
        });
    } catch (err) {
        console.error('Erro ao carregar metas para aluno:', err);
        return res.render('metasdeaula', {
            mensagem: 'Erro ao carregar metas de aula: ' + err.message,
            tipoMensagem: 'danger',
            isProfessorPage: hasProfessorAccess(req.session.usuario),
            turmas: [],
            metas: []
        });
    }
});

app.post('/metasdeaula', async (req, res) => {
    if (!hasProfessorAccess(req.session.usuario)) {
        const mensagem = 'Acesso restrito a professor e administrador.';
        return res.redirect(`/dashboard?mensagem=${encodeURIComponent(mensagem)}`);
    }

    // Nunca confiar no valor do cliente sem revalidar contra a allowlist fixa.
    const returnTo = METASDEAULA_RETURN_TO_ALLOWLIST.has(String(req.body.return_to || ''))
        ? String(req.body.return_to)
        : '';

    try {
        const parseDateOnlyFlexible = (value) => {
            const raw = String(value || '').trim();
            if (!raw) return null;

            // aceita yyyy-mm-dd (input type="date") ou dd/mm/yyyy (máscara)
            const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
            if (isoMatch) {
                const d = new Date(raw);
                if (Number.isNaN(d.getTime())) return null;
                return { iso: raw, date: d };
            }

            const brMatch = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
            if (brMatch) {
                const dd = parseInt(brMatch[1], 10);
                const mm = parseInt(brMatch[2], 10);
                const yyyy = parseInt(brMatch[3], 10);
                const d = new Date(yyyy, mm - 1, dd);
                if (Number.isNaN(d.getTime())) return null;
                // valida consistência (ex: 31/02 vira março)
                if (d.getFullYear() !== yyyy || (d.getMonth() + 1) !== mm || d.getDate() !== dd) return null;
                const iso = `${yyyy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
                return { iso, date: d };
            }

            return null;
        };

        const title = String(req.body.title || '').trim();
        const description = String(req.body.description || '').trim();
        const totalClasses = Number.parseInt(String(req.body.total_classes || '').trim(), 10);
        const minClasses = Number.parseInt(String(req.body.min_classes || '').trim(), 10);
        const startDateRaw = String(req.body.start_date || '').trim();
        const endDateRaw = String(req.body.end_date || '').trim();
        const examStartRaw = String(req.body.exam_start_date || '').trim();
        const examEndRaw = String(req.body.exam_end_date || '').trim();
        const sendNotice = String(req.body.send_notice || 'no').trim().toLowerCase();
        const rawClassCodes = Array.isArray(req.body.class_codes)
            ? req.body.class_codes
            : req.body.class_codes
                ? [req.body.class_codes]
                : [];

        const classCodes = [...new Set(rawClassCodes.map((item) => String(item || '').trim().toUpperCase()).filter(Boolean))];

        if (!title) {
            throw new Error('Informe o título da meta de aula.');
        }
        if (title.length > 50) {
            throw new Error('Título deve ter no máximo 50 caracteres.');
        }
        if (!description) {
            throw new Error('Informe a descrição da meta de aula.');
        }
        if (!Number.isInteger(totalClasses) || totalClasses < 0) {
            throw new Error('Quantidade total de aulas inválida.');
        }
        if (!Number.isInteger(minClasses) || minClasses < 0) {
            throw new Error('Quantidade mínima de aulas inválida.');
        }
        if (minClasses > totalClasses) {
            throw new Error('A quantidade mínima de aulas não pode ser maior que a quantidade total.');
        }
        if (!startDateRaw) {
            throw new Error('Informe a data de início da meta.');
        }
        if (!endDateRaw) {
            throw new Error('Informe a data de término da meta.');
        }
        if (!examStartRaw) {
            throw new Error('Informe o início do período de exame.');
        }
        if (!examEndRaw) {
            throw new Error('Informe o término do período de exame.');
        }

        const startParsed = parseDateOnlyFlexible(startDateRaw);
        const endParsed = parseDateOnlyFlexible(endDateRaw);
        const examStartParsed = parseDateOnlyFlexible(examStartRaw);
        const examEndParsed = parseDateOnlyFlexible(examEndRaw);

        if (!startParsed) {
            throw new Error('Data de início inválida.');
        }
        if (!endParsed) {
            throw new Error('Data de término inválida.');
        }
        if (!examStartParsed) {
            throw new Error('Início do período de exame inválido.');
        }
        if (!examEndParsed) {
            throw new Error('Término do período de exame inválido.');
        }

        if (startParsed.date > endParsed.date) {
            throw new Error('A data de início deve ser anterior ou igual à data de término.');
        }
        if (examStartParsed.date > examEndParsed.date) {
            throw new Error('O início do período de exame deve ser anterior ou igual ao término do período de exame.');
        }
        if (examStartParsed.date < startParsed.date || examEndParsed.date > endParsed.date) {
            throw new Error('O período de exame deve estar dentro do período da meta (início e término).');
        }
        if (classCodes.length === 0) {
            throw new Error('Selecione pelo menos uma turma para aplicar a meta.');
        }

        const activeTurmas = await Turma.findAll({ where: { active: 'Y' }, attributes: ['class_code'] });
        const allowedCodes = new Set(activeTurmas.map((item) => item.class_code));
        const invalidClass = classCodes.some((code) => !allowedCodes.has(code));
        if (invalidClass) {
            throw new Error('Uma ou mais turmas selecionadas não estão disponíveis.');
        }

        // Observação: não bloqueamos títulos "parecidos".
        // Exemplos válidos: "Graduação - 1º Semestre - 2026" e "Graduação - 2º Semestre - 2026".

        const meta = await MetaAula.create({
            title,
            description,
            total_classes: totalClasses,
            min_classes: minClasses,
            start_date: startParsed.iso,
            end_date: endParsed.iso,
            exam_start_date: examStartParsed.iso,
            exam_end_date: examEndParsed.iso,
            keep_notices: sendNotice === 'yes',
            created_by: req.session.usuario.user_code,
            status: 'A'
        });

        await MetaAulaTurma.bulkCreate(classCodes.map((classCode) => ({
            meta_id: meta.id,
            class_code: classCode
        })));

        let mensagem = 'Meta de aula criada com sucesso.';
        let tipo = 'success';

        if (sendNotice === 'yes') {
            const expiresAt = new Date(`${endParsed.iso}T23:59:59`);
            const noticePayload = classCodes.map((classCode) => ({
                title: 'Nova meta de aula',
                content: `Uma nova meta de aula foi criada pelo professor ${req.session.usuario.first_name || ''} ${req.session.usuario.last_name || ''}. Fique ligado(a)!`,
                class: classCode,
                created_by: req.session.usuario.user_code,
                expires_at: expiresAt,
                status: 'A'
            }));

            try {
                await MensagemProfessor.bulkCreate(noticePayload);

                mensagem += ' Aviso enviado aos alunos matriculados.';
            } catch (noticeError) {
                console.error('Erro ao enviar aviso:', noticeError);
                mensagem += ' Não foi possível enviar o aviso aos alunos.';
                tipo = 'warning';
            }
        }

        if (returnTo && meta && meta.id) {
            return res.redirect(`/relatorios/presencas?mode=meta&metaId=${encodeURIComponent(meta.id)}`);
        }
        return res.redirect(`/metasdeaula?mensagem=${encodeURIComponent(mensagem)}&tipo=${tipo}`);
    } catch (err) {
        if (returnTo) {
            const mensagemErro = encodeURIComponent(err.message);
            return res.redirect(`/metasdeaula?returnTo=${encodeURIComponent(returnTo)}&mensagem=${mensagemErro}&tipo=danger`);
        }
        return res.redirect(`/metasdeaula?mensagem=${encodeURIComponent(err.message)}&tipo=danger`);
    }
});

app.post('/mensagens', async (req, res) => {
    if (!hasProfessorAccess(req.session.usuario)) {
        const mensagem = 'Acesso restrito a professor e administrador.';
        return res.redirect(`/dashboard?mensagem=${encodeURIComponent(mensagem)}`);
    }

    try {
        const title = String(req.body.title || '').trim();
        const content = String(req.body.content || '').trim();
        const expiresAtInput = String(req.body.expires_at || '').trim();
        const rawClassCodes = Array.isArray(req.body.class_codes)
            ? req.body.class_codes
            : [req.body.class_codes || req.body.class];

        const classCodes = [...new Set(rawClassCodes.map((item) => String(item || '').trim()).filter(Boolean))];
        const submissionKey = JSON.stringify({
            title,
            content,
            expiresAtInput,
            classCodes: [...classCodes].sort()
        });

        const lastSubmission = req.session.lastMassMessageSubmission;
        const isRepeatedSubmission = Boolean(
            lastSubmission
            && lastSubmission.key === submissionKey
            && (Date.now() - Number(lastSubmission.at || 0)) < 10000
        );

        if (isRepeatedSubmission) {
            const mensagemDuplicada = 'Envio duplicado detectado. A mensagem ja foi processada agora mesmo.';
            return res.redirect(`/mensagens?mensagem=${encodeURIComponent(mensagemDuplicada)}&tipo=warning`);
        }

        if (!title) {
            throw new Error('Informe o titulo da mensagem.');
        }
        if (title.length > 50) {
            throw new Error('Titulo deve ter no maximo 50 caracteres.');
        }

        if (!content) {
            throw new Error('Informe o conteudo da mensagem.');
        }
        if (content.length > 255) {
            throw new Error('Mensagem deve ter no maximo 255 caracteres.');
        }

        if (classCodes.length === 0) {
            throw new Error('Selecione pelo menos uma turma para receber a mensagem.');
        }

        const expiresAt = parseDateTimeInput(expiresAtInput);
        if (!expiresAt) {
            throw new Error('Informe uma data de expiracao valida.');
        }
        if (expiresAt <= new Date()) {
            throw new Error('A data de expiracao deve ser maior que o momento atual.');
        }

        const turmasDisponiveis = await getTurmasDisponiveisParaMensagem(req.session.usuario);
        const allowedCodes = new Set(turmasDisponiveis.map((item) => item.class_code));
        const hasInvalidClass = classCodes.some((code) => !allowedCodes.has(code));
        if (hasInvalidClass) {
            throw new Error('Uma ou mais turmas selecionadas nao estao disponiveis para o seu perfil.');
        }

        const payload = classCodes.map((classCode) => ({
            title,
            content,
            class: classCode,
            created_by: req.session.usuario.user_code,
            expires_at: expiresAt,
            status: 'A'
        }));

        await MensagemProfessor.bulkCreate(payload);

        req.session.lastMassMessageSubmission = {
            key: submissionKey,
            at: Date.now()
        };

        const mensagem = classCodes.length > 1
            ? 'Mensagens em massa criadas com sucesso para as turmas selecionadas.'
            : 'Mensagem em massa criada com sucesso.';

        return res.redirect(`/mensagens?mensagem=${encodeURIComponent(mensagem)}&tipo=success`);
    } catch (err) {
        return res.redirect(`/mensagens?mensagem=${encodeURIComponent(err.message)}&tipo=danger`);
    }
});

app.post('/mensagens/:id/reativar', async (req, res) => {
    if (!hasProfessorAccess(req.session.usuario)) {
        const mensagem = 'Acesso restrito a professor e administrador.';
        return res.redirect(`/dashboard?mensagem=${encodeURIComponent(mensagem)}`);
    }

    try {
        await expireProfessorMessagesIfNeeded();

        const messageId = parseInt(req.params.id, 10);
        if (!Number.isInteger(messageId) || messageId <= 0) {
            throw new Error('Mensagem invalida para reativacao.');
        }

        const title = String(req.body.reactivate_title || '').trim();
        const content = String(req.body.reactivate_content || '').trim();
        const expiresAt = parseDateTimeInput(req.body.reactivate_expires_at);
        const rawClassCodes = Array.isArray(req.body.reactivate_class_codes)
            ? req.body.reactivate_class_codes
            : [req.body.reactivate_class_codes || req.body.reactivate_class_code || ''];
        const classCodes = [...new Set(rawClassCodes.map((item) => String(item || '').trim()).filter(Boolean))];

        if (!title) {
            throw new Error('Informe o titulo da mensagem.');
        }
        if (title.length > 50) {
            throw new Error('Titulo deve ter no maximo 50 caracteres.');
        }

        if (!content) {
            throw new Error('Informe o conteudo da mensagem.');
        }
        if (content.length > 255) {
            throw new Error('Mensagem deve ter no maximo 255 caracteres.');
        }

        if (classCodes.length === 0) {
            throw new Error('Selecione a turma alvo da mensagem.');
        }

        if (!expiresAt) {
            throw new Error('Informe uma nova data de expiracao valida.');
        }
        if (expiresAt <= new Date()) {
            throw new Error('A nova data de expiracao deve ser maior que o momento atual.');
        }

        const turmasDisponiveis = await getTurmasDisponiveisParaMensagem(req.session.usuario);
        const allowedCodes = new Set(turmasDisponiveis.map((item) => item.class_code));
        const hasInvalidClass = classCodes.some((code) => !allowedCodes.has(code));
        if (hasInvalidClass) {
            throw new Error('Uma ou mais turmas selecionadas nao estao disponiveis para o seu perfil.');
        }

        const where = { id: messageId };

        const mensagemExistente = await MensagemProfessor.findOne({ where });
        if (!mensagemExistente) {
            throw new Error('Mensagem nao encontrada ou sem permissao para reativar.');
        }

        mensagemExistente.title = title;
        mensagemExistente.content = content;
        mensagemExistente.class = classCodes[0];
        mensagemExistente.expires_at = expiresAt;
        mensagemExistente.status = 'A';
        await mensagemExistente.save();

        // Reativacao deve voltar como mensagem nova para os alunos.
        await Promise.all([
            MensagemProfessorLeitura.destroy({
                where: { message_id: mensagemExistente.id }
            }),
            MensagemProfessorOcultacao.destroy({
                where: { message_id: mensagemExistente.id }
            })
        ]);

        const additionalClassCodes = classCodes.slice(1);
        if (additionalClassCodes.length > 0) {
            await MensagemProfessor.bulkCreate(
                additionalClassCodes.map((classCode) => ({
                    title,
                    content,
                    class: classCode,
                    created_by: req.session.usuario.user_code,
                    expires_at: expiresAt,
                    status: 'A'
                }))
            );
        }

        const mensagem = classCodes.length > 1
            ? 'Mensagem reativada e replicada com sucesso para as turmas selecionadas.'
            : 'Mensagem reativada com sucesso.';
        return res.redirect(`/mensagens?mensagem=${encodeURIComponent(mensagem)}&tipo=success`);
    } catch (err) {
        return res.redirect(`/mensagens?mensagem=${encodeURIComponent(err.message)}&tipo=danger`);
    }
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

        const activeClassCodes = turmas.map((t) => t.class_code);

        let countByClassCode = {};
        let enrolledUserCodes = [];
        if (activeClassCodes.length > 0) {
            const countRows = await sequelize.query(
                `SELECT ta.class_code AS class_code, COUNT(*) AS cnt
                 FROM tb_turma_alunos ta
                 INNER JOIN tb_usuarios u ON u.user_code = ta.user_code
                 WHERE ta.active = 'Y'
                   AND ta.class_code IN (:codes)
                   AND u.role = 'STD'
                   AND u.user_status = 'A'
                 GROUP BY ta.class_code`,
                { replacements: { codes: activeClassCodes }, type: QueryTypes.SELECT }
            );
            countByClassCode = countRows.reduce((acc, row) => {
                acc[row.class_code] = Number(row.cnt);
                return acc;
            }, {});

            const enrolledRows = await sequelize.query(
                `SELECT DISTINCT ta.user_code AS user_code
                 FROM tb_turma_alunos ta
                 INNER JOIN tb_usuarios u ON u.user_code = ta.user_code
                 WHERE ta.active = 'Y'
                   AND ta.class_code IN (:codes)
                   AND u.role = 'STD'
                   AND u.user_status = 'A'`,
                { replacements: { codes: activeClassCodes }, type: QueryTypes.SELECT }
            );
            enrolledUserCodes = enrolledRows.map((r) => r.user_code);
        }

        const alunoWhere = {
            role: 'STD',
            user_status: 'A'
        };
        if (enrolledUserCodes.length > 0) {
            alunoWhere.user_code = { [Op.notIn]: enrolledUserCodes };
        }

        const alunos = await Usuario.findAll({
            where: alunoWhere,
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

        return res.render('turmas', {
            mensagem: req.query.mensagem || '',
            tipoMensagem: req.query.tipo || 'info',
            turmas: turmasVm,
            alunos: alunosVm,
            totalAlunosAtivos: alunosVm.length
        });
    } catch (err) {
        return res.render('turmas', {
            mensagem: 'Erro ao carregar turmas: ' + err.message,
            tipoMensagem: 'danger',
            turmas: [],
            alunos: [],
            totalAlunosAtivos: 0
        });
    }
});

app.get('/turmas/matriculados/:classCode', async (req, res) => {
    if (!hasProfessorAccess(req.session.usuario)) {
        return res.status(403).json({ ok: false, mensagem: 'Acesso restrito a professor e administrador.' });
    }

    const classCode = String(req.params.classCode || '').trim().toUpperCase();
    const pageRaw = parseInt(req.query.page, 10);
    const currentPageRequested = Number.isInteger(pageRaw) && pageRaw > 0 ? pageRaw : 1;
    const itemsPerPage = 10;
    const pagesPerBlock = 8;

    try {
        const turma = await Turma.findOne({ where: { class_code: classCode, active: 'Y' } });
        if (!turma) {
            return res.status(404).json({ ok: false, mensagem: 'Turma não encontrada ou inativa.' });
        }

        const countRows = await sequelize.query(
            `SELECT COUNT(*) AS cnt
             FROM tb_turma_alunos ta
             INNER JOIN tb_usuarios u ON u.user_code = ta.user_code
             WHERE ta.active = 'Y'
               AND ta.class_code = :classCode
               AND u.role = 'STD'
               AND u.user_status = 'A'`,
            { replacements: { classCode }, type: QueryTypes.SELECT }
        );
        const totalItems = Number(countRows[0]?.cnt || 0);

        const paginationVm = buildPaginationVm(currentPageRequested, totalItems, itemsPerPage, pagesPerBlock);
        const offset = (paginationVm.currentPage - 1) * itemsPerPage;

        const alunoRows = await sequelize.query(
            `SELECT u.user_code AS user_code, u.first_name AS first_name, u.last_name AS last_name, u.photo AS photo
             FROM tb_turma_alunos ta
             INNER JOIN tb_usuarios u ON u.user_code = ta.user_code
             WHERE ta.active = 'Y'
               AND ta.class_code = :classCode
               AND u.role = 'STD'
               AND u.user_status = 'A'
             ORDER BY u.first_name ASC, u.last_name ASC
             LIMIT :limit OFFSET :offset`,
            { replacements: { classCode, limit: itemsPerPage, offset }, type: QueryTypes.SELECT }
        );

        const alunos = alunoRows.map((row) => ({
            user_code: row.user_code,
            full_name: `${row.first_name || ''} ${row.last_name || ''}`.trim() || row.user_code,
            avatar: row.photo || '/uploads/users/default.jpg'
        }));

        return res.json({
            ok: true,
            class_code: classCode,
            class_name: turma.class_name,
            alunos,
            pagination: {
                currentPage: paginationVm.currentPage,
                totalPages: paginationVm.totalPages,
                totalItems: paginationVm.totalItems,
                hasPrev: paginationVm.hasPrev,
                hasNext: paginationVm.hasNext,
                prevPage: paginationVm.prevPage,
                nextPage: paginationVm.nextPage,
                pageNumbers: paginationVm.pageNumbers
            }
        });
    } catch (err) {
        return res.status(500).json({ ok: false, mensagem: err.message || 'Erro ao carregar alunos da turma.' });
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
            const codeTerm = searchTerm.toUpperCase();
            const searchFilters = [
                { first_name: { [Op.like]: `%${searchTerm}%` } },
                { last_name: { [Op.like]: `%${searchTerm}%` } },
                { email: { [Op.like]: `%${searchTerm}%` } },
                { user_code: { [Op.like]: `%${codeTerm}%` } }
            ];

            if (normalizedPhone) {
                searchFilters.push({ phone: { [Op.like]: `%${normalizedPhone}%` } });
            }

            whereClauses.push({ [Op.or]: searchFilters });
        }

        const whereClausesFinal = [...whereClauses];
        if (hasProfessorPrivileges) {
            whereClausesFinal.push({ role: { [Op.in]: ['STD', 'PRO'] } });
        }

        const where = whereClausesFinal.length > 0 ? { [Op.and]: whereClausesFinal } : {};

        const usuarios = await Usuario.findAll({
            where,
            include: [{
                model: Usuario,
                as: 'responsavel',
                attributes: ['id', 'first_name', 'last_name', 'email', 'phone', 'birth_date', 'photo', 'actual_belt', 'actual_degree', 'user_status', 'role', 'wagi_size', 'zubon_size', 'obi_size'],
                required: false
            }],
            order: [['first_name', 'ASC'], ['last_name', 'ASC']]
        });

        const lista = usuarios.map((u) => {
            const usuario = u.get({plain: true});
            const beltDisplay = getBeltDisplayData(usuario.actual_belt, usuario.actual_degree);

            return {
                ...usuario,
                role_label: getRoleLabel(usuario.role),
                user_status_label: usuario.user_status === 'P' ? 'Pendente' : usuario.user_status === 'A' ? 'Ativo' : 'Cancelado',
                can_approve: hasProfessorPrivileges && usuario.user_status === 'P',
                belt_label: beltDisplay.beltLabel,
                degree_label: beltDisplay.degreeLabel,
                belt_summary_label: beltDisplay.summaryLabel,
                belt_image_path: beltDisplay.imagePath,
                responsavel_nome: usuario.responsavel ? `${usuario.responsavel.first_name} ${usuario.responsavel.last_name}` : null,
                responsavel_dados: usuario.responsavel ? {
                    id: usuario.responsavel.id,
                    first_name: usuario.responsavel.first_name,
                    last_name: usuario.responsavel.last_name,
                    email: usuario.responsavel.email,
                    phone: usuario.responsavel.phone,
                    birth_date: usuario.responsavel.birth_date,
                    photo: usuario.responsavel.photo,
                    actual_belt: usuario.responsavel.actual_belt,
                    actual_degree: usuario.responsavel.actual_degree,
                    user_status: usuario.responsavel.user_status,
                    role: usuario.responsavel.role,
                    wagi_size: usuario.responsavel.wagi_size,
                    zubon_size: usuario.responsavel.zubon_size,
                    obi_size: usuario.responsavel.obi_size,
                    belt_label: getBeltDisplayData(usuario.responsavel.actual_belt, usuario.responsavel.actual_degree).beltLabel,
                    degree_label: getBeltDisplayData(usuario.responsavel.actual_belt, usuario.responsavel.actual_degree).degreeLabel,
                    belt_summary_label: getBeltDisplayData(usuario.responsavel.actual_belt, usuario.responsavel.actual_degree).summaryLabel,
                    belt_image_path: getBeltDisplayData(usuario.responsavel.actual_belt, usuario.responsavel.actual_degree).imagePath,
                    user_status_label: usuario.responsavel.user_status === 'P' ? 'Pendente' : usuario.responsavel.user_status === 'A' ? 'Ativo' : 'Cancelado',
                    role_label: getRoleLabel(usuario.responsavel.role)
                } : null
            };
        });

        const sortByName = (a, b) => {
            const nameA = `${a.first_name} ${a.last_name}`.toLowerCase();
            const nameB = `${b.first_name} ${b.last_name}`.toLowerCase();
            return nameA.localeCompare(nameB);
        };

        const pendentes = hasProfessorPrivileges
            ? lista.filter((usuario) => usuario.user_status === 'P').sort(sortByName)
            : [];
        const ativos = lista.filter((usuario) => usuario.user_status === 'A').sort(sortByName);
        const cancelados = hasProfessorPrivileges
            ? lista.filter((usuario) => usuario.user_status === 'C').sort(sortByName)
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

        const pageNumbers = Array.from({length: visiblePages}, (_unused, index) => {
            const pageNumber = startPage + index;
            return {
                number: pageNumber,
                isCurrent: pageNumber === currentPage
            };
        });

        res.render('aluno', {
            mensagem: req.query.mensagem || '',
            tipoMensagem: req.query.tipo || 'info',
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
        res.render('aluno', {
            mensagem: 'Erro ao carregar alunos: ' + err.message,
            tipoMensagem: req.query.tipo || 'info',
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
            responsible_id: dependente.responsible_id,
            actual_belt: dependente.actual_belt || null,
            actual_degree: dependente.actual_degree || null
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

async function findUsuariosWithValidEmailChangeToken(email, token) {
    const norm = normalizeEmail(email);
    if (!norm || !token) {
        return [];
    }

    const candidatos = await Usuario.findAll({
        where: { pending_email: norm }
    });
    const now = new Date();
    const validos = [];

    for (const usuario of candidatos) {
        if (!usuario.email_change_token_hash || !usuario.email_change_expires) {
            continue;
        }

        if (new Date(usuario.email_change_expires) < now) {
            continue;
        }

        try {
            if (await argon2.verify(usuario.email_change_token_hash, token)) {
                validos.push(usuario);
            }
        } catch (_e) {
            // token inválido
        }
    }

    return validos;
}

async function applyConfirmedEmailChangeFromUsuarioRow(usuarioAlvo) {
    const pending = normalizeEmail(usuarioAlvo.pending_email);
    if (!pending) {
        throw new Error('Nenhuma alteração de e-mail pendente para este usuário.');
    }

    const titular = usuarioAlvo.responsible_id
        ? await Usuario.findByPk(usuarioAlvo.responsible_id)
        : usuarioAlvo;

    const baseUser = titular || usuarioAlvo;

    await sequelize.transaction(async (transaction) => {
        if (!usuarioAlvo.responsible_id) {
            await Usuario.update(
                {
                    email: pending,
                    pending_email: null,
                    email_change_token_hash: null,
                    email_change_expires: null
                },
                {
                    where: {
                        [Op.or]: [{ id: baseUser.id }, { responsible_id: baseUser.id }]
                    },
                    transaction
                }
            );
        } else {
            await usuarioAlvo.update(
                {
                    email: pending,
                    pending_email: null,
                    email_change_token_hash: null,
                    email_change_expires: null
                },
                { transaction }
            );
        }
    });
}

app.get('/meuperfil', requireMeuPerfilSession, async (req, res) => {
    try {
        const profileUserId = getEffectiveProfileUserId(req);
        const usuario = await Usuario.findByPk(profileUserId);
        if (!usuario) {
            const mensagem = encodeURIComponent('Usuário não encontrado.');
            return res.redirect(`/dashboard?mensagem=${mensagem}`);
        }

        const titularId = req.session.usuario.id;
        const dependentesAtivos = await Usuario.count({
            where: { responsible_id: titularId, user_status: 'A' }
        });

        const usuarioPlain = usuario.get({ plain: true });

        const beltOptions = BELT_OPTIONS.map((option) => ({
            ...option,
            selected: option.value === usuario.actual_belt
        }));

        const maxDeg = getMaxDegreeForBelt(usuario.actual_belt);
        const degreeOptions = Array.from({ length: maxDeg + 1 }, (_, d) => ({
            value: String(d),
            label: String(d),
            selected: String(d) === String(usuario.actual_degree)
        }));

        return res.render('meuperfil', {
            pageTitle: 'Meu Perfil',
            usuario: usuarioPlain,
            beltOptions,
            degreeOptions,
            kimonoSizeOptions: KIMONO_WAGI_ZUBON_SIZE_OPTIONS,
            obiSizeOptions: OBI_SIZE_OPTIONS,
            titularTemDependentesAtivos: !req.session.viewingAs && dependentesAtivos > 0,
            titularDismissStorageId: req.session.usuario.id,
            mensagem: req.query.mensagem || '',
            tipoMensagem: req.query.tipo || '',
            emailConfirmPreviewLink: req.query.email_preview_link || ''
        });
    } catch (err) {
        console.error(err);
        const mensagem = encodeURIComponent('Erro ao abrir Meu Perfil: ' + err.message);
        return res.redirect(`/dashboard?mensagem=${mensagem}`);
    }
});

app.post('/meuperfil/dados-pessoais', requireMeuPerfilSession, async (req, res) => {
    try {
        const profileUserId = getEffectiveProfileUserId(req);
        const usuario = await Usuario.findByPk(profileUserId);
        if (!usuario) {
            return res.status(404).json({ ok: false, mensagem: 'Usuário não encontrado.' });
        }

        const firstName = normalizePersonName(req.body.first_name);
        const lastName = formatLastNameWithConnectives(req.body.last_name);
        const phoneValidation = validateBrazilMobilePhone(req.body.phone);
        const beltDegreeValidation = validateBeltAndDegree(req.body.actual_belt, req.body.actual_degree);

        if (!firstName || !lastName) {
            return res.status(400).json({ ok: false, mensagem: 'Informe o primeiro nome e o restante do nome.' });
        }

        if (!phoneValidation.ok) {
            return res.status(400).json({ ok: false, mensagem: phoneValidation.message });
        }

        const phoneDigits = phoneValidation.phone;

        if (!beltDegreeValidation.isValid) {
            return res.status(400).json({ ok: false, mensagem: beltDegreeValidation.message });
        }

        usuario.first_name = firstName;
        usuario.last_name = lastName;
        usuario.phone = phoneDigits;
        usuario.actual_belt = beltDegreeValidation.beltValue;
        usuario.actual_degree = beltDegreeValidation.degreeValue;
        await usuario.save();

        if (req.session.usuario.id === usuario.id && !req.session.viewingAs) {
            req.session.usuario.first_name = usuario.first_name;
            req.session.usuario.last_name = usuario.last_name;
            req.session.usuario.actual_belt = usuario.actual_belt;
            req.session.usuario.actual_degree = usuario.actual_degree;
        }

        if (req.session.viewingAs && req.session.viewingAs.id === usuario.id) {
            req.session.viewingAs.first_name = usuario.first_name;
            req.session.viewingAs.last_name = usuario.last_name;
            req.session.viewingAs.actual_belt = usuario.actual_belt;
            req.session.viewingAs.actual_degree = usuario.actual_degree;
        }

        return res.json({ ok: true, mensagem: 'Dados pessoais salvos com sucesso.' });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ ok: false, mensagem: err.message || 'Erro ao salvar.' });
    }
});

app.post('/meuperfil/medidas', requireMeuPerfilSession, async (req, res) => {
    try {
        const profileUserId = getEffectiveProfileUserId(req);
        const usuario = await Usuario.findByPk(profileUserId);
        if (!usuario) {
            return res.status(404).json({ ok: false, mensagem: 'Usuário não encontrado.' });
        }

        const wagi = String(req.body.wagi_size || '').trim().toUpperCase();
        const zubon = String(req.body.zubon_size || '').trim().toUpperCase();
        const obi = String(req.body.obi_size || '').trim().toUpperCase();

        if (!KIMONO_SIZE_CODES.has(wagi) || !KIMONO_SIZE_CODES.has(zubon)) {
            return res.status(400).json({ ok: false, mensagem: 'Selecione tamanhos válidos para Wagi e Zubon.' });
        }

        if (!OBI_SIZE_CODES.has(obi)) {
            return res.status(400).json({ ok: false, mensagem: 'Selecione um tamanho válido para a faixa (Obi).' });
        }

        usuario.wagi_size = wagi;
        usuario.zubon_size = zubon;
        usuario.obi_size = obi;
        await usuario.save();

        return res.json({ ok: true, mensagem: 'Medidas salvas com sucesso.' });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ ok: false, mensagem: err.message || 'Erro ao salvar.' });
    }
});

app.post('/meuperfil/seguranca', requireMeuPerfilSession, async (req, res) => {
    try {
        const profileUserId = getEffectiveProfileUserId(req);
        const usuario = await Usuario.findByPk(profileUserId);
        if (!usuario) {
            return res.status(404).json({ ok: false, mensagem: 'Usuário não encontrado.' });
        }

        const currentEmailNorm = normalizeEmail(usuario.email);
        const emailInput = normalizeEmail(req.body.email);
        const newPassword = String(req.body.new_password || '');
        const newPassword2 = String(req.body.new_password_confirm || '');

        if (!emailInput) {
            return res.status(400).json({ ok: false, mensagem: 'Informe o e-mail de login.' });
        }

        let logoutRequired = false;
        const responseExtras = {};
        let emailChangeRequested = false;

        if (newPassword || newPassword2) {
            if (!newPassword || !newPassword2) {
                return res.status(400).json({ ok: false, mensagem: 'Preencha a nova senha e a confirmação, ou deixe ambos em branco.' });
            }

            if (newPassword.length < 6) {
                return res.status(400).json({ ok: false, mensagem: 'A nova senha deve ter pelo menos 6 caracteres.' });
            }

            if (newPassword !== newPassword2) {
                return res.status(400).json({ ok: false, mensagem: 'A confirmação da nova senha não confere.' });
            }

            const mesmaSenha = await argon2.verify(usuario.password, newPassword).catch(() => false);
            if (mesmaSenha) {
                return res.status(400).json({ ok: false, mensagem: 'A nova senha não pode ser igual à senha atual.' });
            }

            usuario.password = await argon2.hash(newPassword);
            await usuario.save();
            logoutRequired = true;
        }

        if (emailInput !== currentEmailNorm) {
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailInput)) {
                return res.status(400).json({ ok: false, mensagem: 'Informe um e-mail válido para o novo login.' });
            }

            const token = crypto.randomBytes(32).toString('hex');
            const tokenHash = await argon2.hash(token);
            usuario.pending_email = emailInput;
            usuario.email_change_token_hash = tokenHash;
            usuario.email_change_expires = new Date(Date.now() + EMAIL_CHANGE_TOKEN_TTL_MS);
            await usuario.save();
            emailChangeRequested = true;

            const mailResult = await sendProfileEmailChangeConfirmation(req, emailInput, token);
            if (mailResult.deliveryStatus === 'preview') {
                responseExtras.emailPreviewLink = mailResult.link;
            }
        }

        if (logoutRequired) {
            let msg = 'Senha alterada. Faça login novamente com a nova senha.';
            if (emailChangeRequested) {
                msg += ' Há também uma alteração de e-mail pendente de confirmação no novo endereço.';
            }

            return res.json({
                ok: true,
                mensagem: msg,
                logout: true,
                ...responseExtras
            });
        }

        return res.json({
            ok: true,
            mensagem: emailChangeRequested
                ? 'Enviamos um e-mail para o novo endereço com o link de confirmação. Use também o botão de confirmação nesta página após validar o e-mail.'
                : 'Nenhuma alteração de senha ou e-mail aplicada.',
            ...responseExtras
        });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ ok: false, mensagem: err.message || 'Erro ao salvar.' });
    }
});

app.post('/meuperfil/confirmar-email', requireMeuPerfilSession, async (req, res) => {
    try {
        const profileUserId = getEffectiveProfileUserId(req);
        const usuario = await Usuario.findByPk(profileUserId);
        if (!usuario || !usuario.pending_email) {
            return res.status(400).json({ ok: false, mensagem: 'Não há alteração de e-mail pendente para confirmar.' });
        }

        await applyConfirmedEmailChangeFromUsuarioRow(usuario);

        return req.session.destroy(() => {
            res.clearCookie('oss.sid');
            return res.json({
                ok: true,
                mensagem: 'E-mail atualizado. Faça login com o novo endereço.',
                logout: true
            });
        });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ ok: false, mensagem: err.message || 'Erro ao confirmar e-mail.' });
    }
});

/** Meu Perfil: troca de avatar. PRO/ADM aplicam na hora; STD entra em fila de aprovação. */
app.post('/meuperfil/avatar', requireMeuPerfilSession, (req, res) => {
    upload.single('photo')(req, res, async (multerErr) => {
        if (multerErr) {
            const mensagem = multerErr.code === 'LIMIT_FILE_SIZE'
                ? 'A imagem deve ter no máximo 10 MB.'
                : 'Falha ao enviar a imagem.';
            return res.status(400).json({ ok: false, mensagem });
        }

        if (!req.file) {
            return res.status(400).json({ ok: false, mensagem: 'Selecione uma imagem.' });
        }

        const tempFilePath = path.join(uploadsDir, req.file.filename);

        try {
            const allowedMimeTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif'];
            if (!allowedMimeTypes.includes(req.file.mimetype)) {
                await fs.promises.unlink(tempFilePath);
                return res.status(400).json({ ok: false, mensagem: 'Formatos permitidos: JPG, PNG ou GIF.' });
            }

            const metadata = await sharp(tempFilePath).metadata();
            if (!metadata.width || !metadata.height || metadata.width < 200 || metadata.height < 200) {
                await fs.promises.unlink(tempFilePath);
                return res.status(400).json({ ok: false, mensagem: 'A imagem deve ter no mínimo 200x200 pixels.' });
            }

            const profileUserId = getEffectiveProfileUserId(req);
            const usuario = await Usuario.findByPk(profileUserId);
            if (!usuario) {
                await fs.promises.unlink(tempFilePath);
                return res.status(404).json({ ok: false, mensagem: 'Usuário não encontrado.' });
            }

            if (hasProfessorAccess(usuario)) {
                await replaceUserPhoto(usuario, req.file.filename);
                return res.json({ ok: true, mensagem: 'Avatar atualizado com sucesso.', tipo: 'success' });
            }

            const pendente = await AvatarChangeRequest.findOne({ where: { user_code: usuario.user_code } });
            if (pendente) {
                const oldTempPath = path.join(uploadsDir, pendente.temp_photo_filename);
                if (fs.existsSync(oldTempPath)) {
                    await fs.promises.unlink(oldTempPath);
                }
                await pendente.destroy();
            }

            await AvatarChangeRequest.create({
                user_code: usuario.user_code,
                temp_photo_filename: req.file.filename
            });

            return res.json({
                ok: true,
                mensagem: 'Sua nova foto foi enviada e passará por uma análise. Você será notificado quando o professor decidir.',
                tipo: 'warning'
            });
        } catch (err) {
            console.error(err);
            if (fs.existsSync(tempFilePath)) {
                await fs.promises.unlink(tempFilePath);
            }
            return res.status(500).json({ ok: false, mensagem: err.message || 'Erro ao processar a imagem.' });
        }
    });
});

app.get('/meuperfil/confirmar-email', async (req, res) => {
    const email = normalizeEmail(req.query.email);
    const token = typeof req.query.token === 'string' ? req.query.token.trim() : '';

    try {
        const validos = await findUsuariosWithValidEmailChangeToken(email, token);
        if (validos.length === 0) {
            const mensagem = encodeURIComponent('Link inválido ou expirado. Solicite novamente a alteração de e-mail em Meu Perfil.');
            return res.redirect(`/auth/login?erro=${mensagem}`);
        }

        await applyConfirmedEmailChangeFromUsuarioRow(validos[0]);

        const finish = () => {
            const mensagem = encodeURIComponent('E-mail confirmado. Faça login com o novo endereço.');
            return res.redirect(`/auth/login?aviso=${mensagem}`);
        };

        if (req.session && req.session.usuario) {
            return req.session.destroy(() => {
                res.clearCookie('oss.sid');
                return finish();
            });
        }

        return finish();
    } catch (err) {
        console.error(err);
        const mensagem = encodeURIComponent('Erro ao confirmar e-mail: ' + err.message);
        return res.redirect(`/auth/login?erro=${mensagem}`);
    }
});

app.get('/aluno/novo', async (req, res) => {
    try {
        const turmaOptions = await getActiveTurmasOptions();
        const vm = buildUserFormViewModel(null, false, turmaOptions);

        Object.assign(vm, {
            metaTitle: 'Solicitar Acesso | Cadastro de Aluno CRTN Belém',
            metaDescription: 'Cadastre-se como novo aluno no portal CRTN Belém e acompanhe turmas, presenças e metas de treino.',
            metaUrl: `${req.protocol}://${req.get('host')}${req.originalUrl}`,
            metaImage: '/img/logotipo.ico',
            metaRobots: 'index,follow'
        });

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
    const renderFormWithError = async (errorMessage, fieldErrors = {}, tipoMensagem = 'erro') => {
        const responsibleId = req.body.responsible_id ? parseInt(req.body.responsible_id, 10) : null;
        const turmaOptions = await getActiveTurmasOptions(req.body.class_code || '');

        const formData = {
            first_name: req.body.first_name || '',
            last_name: req.body.last_name || '',
            email: req.body.email || '',
            phone: String(req.body.phone || '').replace(/\D/g, '').slice(0, 11),
            birth_date: req.body.birth_date || '',
            actual_belt: req.body.actual_belt || '',
            actual_degree: req.body.actual_degree || '0',
            wagi_size: String(req.body.wagi_size || '').trim().toUpperCase(),
            zubon_size: String(req.body.zubon_size || '').trim().toUpperCase(),
            obi_size: String(req.body.obi_size || '').trim().toUpperCase(),
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
            kimonoSizeOptions: KIMONO_WAGI_ZUBON_SIZE_OPTIONS,
            obiSizeOptions: OBI_SIZE_OPTIONS,
            mensagem: errorMessage,
            tipoMensagem,
            camposErro: fieldErrors,
            metaTitle: 'Solicitar Acesso | Novo Aluno CRTN Belém',
            metaDescription: 'Cadastre-se como novo aluno no sistema CRTN Belém para acompanhamento de turmas, presenças e metas.',
            metaUrl: `${req.protocol}://${req.get('host')}/aluno/novo`,
            metaImage: '/img/logotipo.ico',
            metaRobots: 'index,follow'
        };

        res.render('formnovousuario', vm);
    };

    try {
        const requiredFields = [
            'first_name',
            'last_name',
            'phone',
            'birth_date',
            'actual_belt',
            'actual_degree',
            'wagi_size',
            'zubon_size',
            'obi_size',
            'class_code'
        ];
        const missing = requiredFields.filter((field) => !String(req.body[field] || '').trim());
        const fieldErrors = {};
        missing.forEach((field) => {
            fieldErrors[field] = 'Campo obrigatório.';
        });
        if (!req.body.email && !req.body.responsible_id) {
            fieldErrors.email = 'Campo obrigatório.';
        }
        if (!req.body.password1 || !req.body.password2) {
            fieldErrors.password = 'Campo obrigatório.';
        }
        if (!req.file) {
            fieldErrors.photo = 'Envie uma foto para continuar.';
        }
        if (Object.keys(fieldErrors).length > 0) {
            return renderFormWithError('Preencha todos os campos obrigatórios para continuar.', fieldErrors);
        }

        const phoneValidation = validateBrazilMobilePhone(req.body.phone);
        if (!phoneValidation.ok) {
            if (req.file) {
                const tempFilePath = path.join(uploadsDir, req.file.filename);
                if (fs.existsSync(tempFilePath)) {
                    await fs.promises.unlink(tempFilePath);
                }
            }
            return renderFormWithError('Corrija os campos em desconformidade abaixo.', {
                phone: phoneValidation.message
            });
        }
        const phoneDigits = phoneValidation.phone;

        const responsibleId = req.body.responsible_id ? parseInt(req.body.responsible_id, 10) : null;
        const isDependent = !!responsibleId;
        const classCode = String(req.body.class_code || '').trim().toUpperCase();
        let titular = null;

        // Cadastro de titular: um mesmo e-mail só pode ter 1 titular no sistema.
        if (!isDependent) {
            const emailInformado = normalizeEmail(req.body.email);
            const titularExistente = await Usuario.findOne({
                where: { email: emailInformado, responsible_id: null }
            });

            if (titularExistente) {
                if (req.file) {
                    const tempFilePath = path.join(uploadsDir, req.file.filename);
                    if (fs.existsSync(tempFilePath)) {
                        await fs.promises.unlink(tempFilePath);
                    }
                }
                const avisoEmail = titularExistente.user_status === 'P'
                    ? 'Este e-mail já está cadastrado e aguardando aprovação de um professor.'
                    : 'Este e-mail já está cadastrado no sistema.';
                return renderFormWithError(avisoEmail, { email: avisoEmail }, 'desconformidade');
            }
        }

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

        const wagiCode = String(req.body.wagi_size || '').trim().toUpperCase();
        const zubonCode = String(req.body.zubon_size || '').trim().toUpperCase();
        const obiCode = String(req.body.obi_size || '').trim().toUpperCase();
        if (!KIMONO_SIZE_CODES.has(wagiCode) || !KIMONO_SIZE_CODES.has(zubonCode)) {
            if (req.file) {
                const tempFilePath = path.join(uploadsDir, req.file.filename);
                if (fs.existsSync(tempFilePath)) {
                    await fs.promises.unlink(tempFilePath);
                }
            }
            const medidasErr = {};
            if (!KIMONO_SIZE_CODES.has(wagiCode)) {
                medidasErr.wagi_size = 'Selecione um tamanho válido para a jaqueta (Wagi).';
            }
            if (!KIMONO_SIZE_CODES.has(zubonCode)) {
                medidasErr.zubon_size = 'Selecione um tamanho válido para a calça (Zubon).';
            }
            return renderFormWithError('Corrija os campos em desconformidade abaixo.', medidasErr);
        }
        if (!OBI_SIZE_CODES.has(obiCode)) {
            if (req.file) {
                const tempFilePath = path.join(uploadsDir, req.file.filename);
                if (fs.existsSync(tempFilePath)) {
                    await fs.promises.unlink(tempFilePath);
                }
            }
            return renderFormWithError('Corrija os campos em desconformidade abaixo.', {
                obi_size: 'Selecione um tamanho válido para a faixa (Obi).'
            });
        }

        const passwordHash = await argon2.hash(senha);

        let emailFinal = normalizeEmail(req.body.email);
        if (isDependent) {
            emailFinal = normalizeEmail(titular.email);
        }

        const firstNameFinal = normalizePersonName(req.body.first_name);
        const lastNameFinal = formatLastNameWithConnectives(req.body.last_name);

        if (!firstNameFinal || !lastNameFinal) {
            const fieldErrors = {};
            if (!firstNameFinal) fieldErrors.first_name = 'Campo obrigatório.';
            if (!lastNameFinal) fieldErrors.last_name = 'Campo obrigatório.';
            return renderFormWithError('Corrija os campos em desconformidade abaixo.', fieldErrors);
        }

        const usuario = await Usuario.create({
            user_code: generatedCode(),
            first_name: firstNameFinal,
            last_name: lastNameFinal,
            email: emailFinal,
            password: passwordHash,
            role: 'STD',
            user_status: 'P',
            phone: phoneDigits,
            birth_date: req.body.birth_date,
            actual_belt: beltDegreeValidation.beltValue,
            actual_degree: beltDegreeValidation.degreeValue,
            wagi_size: wagiCode,
            zubon_size: zubonCode,
            obi_size: obiCode,
            responsible_id: responsibleId || null,
            class_code: classCode,
            // Foto já entra no create: evita que o registro fique com o default.jpg do model
            // até uma segunda gravação (e persistindo com default.jpg caso ela falhasse).
            photo: `/uploads/users/${req.file.filename}`
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

        return res.render('formnovousuario', {
            ...buildUserFormViewModel(usuario, true),
            mensagem: req.query.mensagem || '',
            tipoMensagem: req.query.tipo || 'info'
        });
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

        const phoneValidation = validateBrazilMobilePhone(req.body.phone);
        if (!phoneValidation.ok) {
            if (req.file) {
                const tempFilePath = path.join(uploadsDir, req.file.filename);
                if (fs.existsSync(tempFilePath)) {
                    await fs.promises.unlink(tempFilePath);
                }
            }
            const q = new URLSearchParams({
                mensagem: phoneValidation.message,
                tipo: 'erro'
            });
            return res.redirect(`/aluno/editar/${alunoId}?${q.toString()}`);
        }
        const phoneDigits = phoneValidation.phone;

        usuario.email = req.body.email;
        usuario.phone = phoneDigits;

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

        const wagiCodeEd = String(req.body.wagi_size || '').trim().toUpperCase();
        const zubonCodeEd = String(req.body.zubon_size || '').trim().toUpperCase();
        const obiCodeEd = String(req.body.obi_size || '').trim().toUpperCase();
        if (!KIMONO_SIZE_CODES.has(wagiCodeEd) || !KIMONO_SIZE_CODES.has(zubonCodeEd)) {
            if (req.file) {
                const tempFilePath = path.join(uploadsDir, req.file.filename);
                if (fs.existsSync(tempFilePath)) {
                    await fs.promises.unlink(tempFilePath);
                }
            }
            const mensagem = 'Selecione tamanhos válidos para Wagi e Zubon.';
            return res.redirect(`/aluno?mensagem=${encodeURIComponent(mensagem)}`);
        }
        if (!OBI_SIZE_CODES.has(obiCodeEd)) {
            if (req.file) {
                const tempFilePath = path.join(uploadsDir, req.file.filename);
                if (fs.existsSync(tempFilePath)) {
                    await fs.promises.unlink(tempFilePath);
                }
            }
            const mensagem = 'Selecione um tamanho válido para a faixa (Obi).';
            return res.redirect(`/aluno?mensagem=${encodeURIComponent(mensagem)}`);
        }
        usuario.wagi_size = wagiCodeEd;
        usuario.zubon_size = zubonCodeEd;
        usuario.obi_size = obiCodeEd;

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

        // Apaga foto temporária (se existir) e depois remove o registro do aluno,
        // garantindo que nenhum dado de cadastro pendente permaneça no sistema.
        await deleteUserTempPhotoIfExists(usuario);
        await usuario.destroy();

        const mensagem = 'Cadastro negado e dados removidos com sucesso.';
        return res.redirect(`/aluno?mensagem=${encodeURIComponent(mensagem)}`);
    } catch (err) {
        const mensagem = 'Erro: ' + err.message;
        return res.redirect(`/aluno?mensagem=${encodeURIComponent(mensagem)}`);
    }
});

// Atualizar status do aluno (POST)
app.post('/aluno/status/:id', async (req, res) => {
    if (!hasProfessorAccess(req.session.usuario)) {
        return res.status(403).json({ error: 'Acesso não permitido' });
    }

    const alunoId = req.params.id;
    const newStatus = req.body.newStatus || (req.query.status || '').trim();

    try {
        const usuario = await Usuario.findByPk(alunoId);
        if (!usuario) {
            return res.status(404).json({ error: 'Aluno não encontrado' });
        }

        const previousStatus = usuario.user_status;

        // Validar transição de status
        const validTransitions = {
            'P': ['A', 'C'],      // Pendente pode ir para Ativo ou Cancelado
            'A': ['C'],           // Ativo pode ir para Cancelado
            'C': ['A']            // Cancelado pode ir para Ativo
        };

        if (!validTransitions[usuario.user_status] || !validTransitions[usuario.user_status].includes(newStatus)) {
            return res.status(400).json({ 
                error: `Transição inválida de ${usuario.user_status} para ${newStatus}` 
            });
        }

        usuario.user_status = newStatus;
        await usuario.save();

        let finalizedPhoto = null;
        if (previousStatus === 'P' && newStatus === 'A') {
            try {
                finalizedPhoto = await finalizePendingPhotoIfNeeded(usuario);
            } catch (error) {
                usuario.user_status = 'P';
                await usuario.save();
                return res.status(500).json({
                    ok: false,
                    error: 'Erro ao aprovar foto do cadastro: ' + error.message
                });
            }
        }

        return res.status(200).json({ 
            ok: true, 
            message: 'Status atualizado com sucesso',
            newStatus,
            photo: usuario.photo,
            finalizedPhoto: finalizedPhoto ? {
                finalFileName: finalizedPhoto.finalFileName,
                fileSize: finalizedPhoto.fileSize
            } : null
        });
    } catch (err) {
        return res.status(500).json({ error: 'Erro ao atualizar status: ' + err.message });
    }
});

async function verifyUsuarioPasswordPlain(usuarioRow, plainPassword) {
    if (!usuarioRow || plainPassword == null) {
        return false;
    }
    const pwd = usuarioRow.password;
    if (typeof pwd === 'string' && pwd.startsWith('$argon2')) {
        try {
            return await argon2.verify(pwd, plainPassword);
        } catch (_e) {
            return false;
        }
    }
    return pwd === plainPassword;
}

async function deleteStudentUserAndRelatedRows(usuario, transaction) {
    const userCode = String(usuario.user_code || '').trim();
    if (!userCode) {
        throw new Error('Código de usuário inválido.');
    }

    const mensagensCriadas = await MensagemProfessor.findAll({
        where: { created_by: userCode },
        attributes: ['id'],
        transaction
    });
    const msgIds = mensagensCriadas.map((m) => m.id).filter((id) => Number.isInteger(id));
    if (msgIds.length) {
        await MensagemProfessorLeitura.destroy({ where: { message_id: { [Op.in]: msgIds } }, transaction });
        await MensagemProfessorOcultacao.destroy({ where: { message_id: { [Op.in]: msgIds } }, transaction });
        await MensagemProfessor.destroy({ where: { id: { [Op.in]: msgIds } }, transaction });
    }

    await MensagemProfessorLeitura.destroy({ where: { user_code: userCode }, transaction });
    await MensagemProfessorOcultacao.destroy({ where: { user_code: userCode }, transaction });
    await Notificacao.destroy({ where: { user_code: userCode }, transaction });
    await Presenca.destroy({
        where: {
            [Op.or]: [{ user_code: userCode }, { processed_by: userCode }]
        },
        transaction
    });
    await TurmaAluno.destroy({ where: { user_code: userCode }, transaction });
    await AppActivityLog.destroy({ where: { user_code: userCode }, transaction });

    const metasDoAluno = await MetaAula.findAll({
        where: { created_by: userCode },
        attributes: ['id'],
        transaction
    });
    const metaIds = metasDoAluno.map((m) => m.id).filter((id) => Number.isInteger(id));
    if (metaIds.length) {
        await MetaAulaTurma.destroy({ where: { meta_id: { [Op.in]: metaIds } }, transaction });
        await MetaAula.destroy({ where: { id: { [Op.in]: metaIds } }, transaction });
    }

    await usuario.destroy({ transaction });
}

app.post('/aluno/excluir/:id', async (req, res) => {
    if (!hasProfessorAccess(req.session.usuario)) {
        return res.status(403).json({ ok: false, error: 'Acesso não permitido.' });
    }

    const alunoId = parseInt(req.params.id, 10);
    const password = typeof req.body.password === 'string' ? req.body.password : '';

    if (!Number.isInteger(alunoId) || alunoId <= 0) {
        return res.status(400).json({ ok: false, error: 'Aluno inválido.' });
    }
    if (!password) {
        return res.status(400).json({ ok: false, error: 'Informe a sua senha para confirmar a exclusão.' });
    }

    try {
        const actor = await Usuario.findByPk(req.session.usuario.id);
        if (!actor) {
            return res.status(401).json({ ok: false, error: 'Sessão inválida. Faça login novamente.' });
        }

        const senhaOk = await verifyUsuarioPasswordPlain(actor, password);
        if (!senhaOk) {
            return res.status(401).json({ ok: false, error: 'Senha incorreta.' });
        }

        const aluno = await Usuario.findByPk(alunoId);
        if (!aluno) {
            return res.status(404).json({ ok: false, error: 'Aluno não encontrado.' });
        }

        if (aluno.role !== 'STD') {
            return res.status(400).json({ ok: false, error: 'Somente cadastros de aluno (perfil aluno) podem ser excluídos por esta ação.' });
        }

        if (String(aluno.id) === String(req.session.usuario.id)) {
            return res.status(400).json({ ok: false, error: 'Não é permitido excluir o próprio usuário.' });
        }

        const vinculados = await Usuario.count({
            where: { responsible_id: aluno.id }
        });
        if (vinculados > 0) {
            return res.status(400).json({
                ok: false,
                error: 'Este usuário possui dependentes vinculados. Ajuste ou exclua os dependentes antes de excluir este cadastro.'
            });
        }

        const photoPath = aluno.photo;

        await sequelize.transaction(async (transaction) => {
            await deleteStudentUserAndRelatedRows(aluno, transaction);
        });

        try {
            const fileName = getFileNameFromPhotoPath(photoPath);
            if (fileName && fileName !== 'default.jpg') {
                const filePath = path.join(uploadsDir, fileName);
                if (fs.existsSync(filePath)) {
                    await fs.promises.unlink(filePath);
                }
            }
        } catch (fileErr) {
            console.error('Erro ao remover arquivos de foto do aluno excluído:', fileErr.message);
        }

        return res.status(200).json({ ok: true, message: 'Aluno e dados vinculados excluídos com sucesso.' });
    } catch (err) {
        console.error('Erro ao excluir aluno:', err);
        return res.status(500).json({ ok: false, error: err.message || 'Erro ao excluir aluno.' });
    }
});

app.get('/promoveraluno', async (req, res) => {
    if (!hasProfessorAccess(req.session.usuario)) {
        const mensagem = 'Apenas professor ou administrador pode acessar esta página.';
        return res.redirect(`/dashboard?mensagem=${encodeURIComponent(mensagem)}`);
    }

    const pageRaw = parseInt(req.query.page, 10);
    const currentPageRequested = Number.isInteger(pageRaw) && pageRaw > 0 ? pageRaw : 1;
    const itemsPerPage = 10;
    const pagesPerBlock = 8;
    const baseWhere = { role: 'STD', user_status: 'A' };

    const emptyPagination = {
        currentPage: 1,
        totalPages: 1,
        totalItems: 0,
        hasPrev: false,
        hasNext: false,
        prevPage: 1,
        nextPage: 1,
        pageNumbers: [{ number: 1, isCurrent: true }]
    };

    try {
        const totalItems = await Usuario.count({ where: baseWhere });
        const paginationVm = buildPaginationVm(currentPageRequested, totalItems, itemsPerPage, pagesPerBlock);
        const offset = (paginationVm.currentPage - 1) * itemsPerPage;

        const usuarios = await Usuario.findAll({
            where: baseWhere,
            order: [['first_name', 'ASC'], ['last_name', 'ASC']],
            attributes: ['id', 'first_name', 'last_name', 'photo', 'role', 'user_status'],
            limit: itemsPerPage,
            offset
        });

        const lista = usuarios.map((u) => {
            const usuario = u.get({ plain: true });
            return {
                ...usuario,
                role_label: getRoleLabel(usuario.role)
            };
        });

        return res.render('promoveraluno', {
            mensagem: req.query.mensagem || '',
            tipoMensagem: req.query.tipo || '',
            usuarios: lista,
            pagination: {
                currentPage: paginationVm.currentPage,
                totalPages: paginationVm.totalPages,
                totalItems: paginationVm.totalItems,
                hasPrev: paginationVm.hasPrev,
                hasNext: paginationVm.hasNext,
                prevPage: paginationVm.prevPage,
                nextPage: paginationVm.nextPage,
                pageNumbers: paginationVm.pageNumbers
            }
        });
    } catch (err) {
        return res.render('promoveraluno', {
            mensagem: 'Erro ao carregar alunos: ' + err.message,
            tipoMensagem: 'danger',
            usuarios: [],
            pagination: emptyPagination
        });
    }
});

app.post('/promoveraluno', async (req, res) => {
    if (!hasProfessorAccess(req.session.usuario)) {
        return res.status(403).json({ ok: false, error: 'Acesso não permitido.' });
    }

    const rawId = req.body.userId != null ? req.body.userId : req.body.id;
    const userId = parseInt(rawId, 10);
    const rawProfessor = req.body.isProfessor;
    const isProfessor =
        rawProfessor === true ||
        rawProfessor === 'true' ||
        rawProfessor === 1 ||
        rawProfessor === '1';

    if (!Number.isInteger(userId) || userId <= 0) {
        return res.status(400).json({ ok: false, error: 'Usuário inválido.' });
    }

    try {
        const usuario = await Usuario.findByPk(userId);
        if (!usuario) {
            return res.status(404).json({ ok: false, error: 'Usuário não encontrado.' });
        }

        if (usuario.role === 'ADM') {
            return res.status(400).json({ ok: false, error: 'Não é permitido alterar o perfil de administrador.' });
        }

        if (isProfessor) {
            if (usuario.role !== 'STD') {
                return res.status(400).json({ ok: false, error: 'Apenas alunos podem ser promovidos a professor.' });
            }
            usuario.role = 'PRO';
            await usuario.save();
        } else {
            if (usuario.role !== 'PRO') {
                return res.status(400).json({ ok: false, error: 'Apenas professores podem ser definidos como alunos.' });
            }
            usuario.role = 'STD';
            await usuario.save();
        }

        const sessao = req.session.usuario;
        if (sessao && sessao.id === usuario.id) {
            sessao.role = usuario.role;
        }

        return res.status(200).json({
            ok: true,
            role: usuario.role,
            message: isProfessor ? 'Usuário promovido a professor.' : 'Usuário definido como aluno.'
        });
    } catch (err) {
        return res.status(500).json({ ok: false, error: 'Erro ao atualizar perfil: ' + err.message });
    }
});

// Retorna estatísticas da meta atual do aluno (para modal /aluno)
app.get('/aluno/:id/meta-atual', async (req, res) => {
    if (!hasProfessorAccess(req.session.usuario)) {
        return res.status(403).json({ ok: false, mensagem: 'Acesso não permitido.' });
    }

    try {
        const alunoId = parseInt(req.params.id, 10);
        if (!Number.isInteger(alunoId) || alunoId <= 0) {
            return res.status(400).json({ ok: false, mensagem: 'ID inválido.' });
        }

        const aluno = await Usuario.findByPk(alunoId, { attributes: ['id', 'user_code', 'role'] });
        if (!aluno || !['STD', 'PRO'].includes(aluno.role)) {
            return res.status(404).json({ ok: false, mensagem: 'Aluno não encontrado.' });
        }

        if (aluno.role === 'PRO') {
            return res.json({ ok: true, progress: null });
        }

        const progress = await getCurrentMetaProgressForStudent(aluno.user_code);
        return res.json({ ok: true, progress });
    } catch (err) {
        return res.status(500).json({ ok: false, mensagem: 'Erro ao calcular meta atual: ' + err.message });
    }
});

// FUNÇÕES DE PRESENÇAS

/** Calendário das aulas / contagem no fuso de Brasília (sem horário de verão). */
const PRESENCA_BR_UTC_OFFSET_MIN = -180;

function presencaDatePartsFromYmd(dateStr) {
    const p = String(dateStr || '')
        .trim()
        .split('-')
        .map((x) => parseInt(x, 10));
    if (p.length !== 3 || p.some((n) => !Number.isFinite(n))) {
        return null;
    }
    return { y: p[0], mo: p[1], d: p[2] };
}

/** Intervalo UTC do dia civil YYYY-MM-DD (armazenamento e deduplicação). */
function presencaUtcRangeForYmd(dateStr) {
    const parts = presencaDatePartsFromYmd(dateStr);
    if (!parts) {
        return null;
    }
    const { y, mo, d } = parts;
    return {
        start: new Date(Date.UTC(y, mo - 1, d, 0, 0, 0, 0)),
        end: new Date(Date.UTC(y, mo - 1, d, 23, 59, 59, 999)),
        noon: new Date(Date.UTC(y, mo - 1, d, 12, 0, 0, 0))
    };
}

/** Dia civil Y-M-D a partir do instante gravado (UTC) — meio-dia UTC evita mudar o dia civil. */
function presencaCivilYmdFromDbDate(requestDate) {
    const dt = requestDate instanceof Date ? requestDate : new Date(requestDate);
    if (Number.isNaN(dt.getTime())) {
        return null;
    }
    const y = dt.getUTCFullYear();
    const m = dt.getUTCMonth() + 1;
    const d = dt.getUTCDate();
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Dia da semana (0=dom..2=ter) para uma data civil YYYY-MM-DD (Gregoriano, independente de fuso). */
function civilDateWeekdaySun0FromYmd(ymd) {
    const parts = presencaDatePartsFromYmd(ymd);
    if (!parts) {
        return null;
    }
    const { y, mo, d } = parts;
    return new Date(Date.UTC(y, mo - 1, d, 12, 0, 0, 0)).getUTCDay();
}

/** Y-M-D civil no calendário de Brasília (terça-feira = grade da academia). */
function presencaCivilYmdBrasil(requestDate) {
    const m = moment(requestDate);
    if (!m.isValid()) {
        return null;
    }
    return m.utcOffset(PRESENCA_BR_UTC_OFFSET_MIN).format('YYYY-MM-DD');
}

function presencaMatchesSolicitacaoDay(requestDate, dateStr) {
    const br = presencaCivilYmdBrasil(requestDate);
    const utc = presencaCivilYmdFromDbDate(requestDate);
    return dateStr === br || dateStr === utc;
}

function presencaDuplicateQueryRange(dateStr) {
    const parts = presencaDatePartsFromYmd(dateStr);
    if (!parts) {
        return null;
    }
    const { y, mo, d } = parts;
    const center = moment.utc([y, mo - 1, d, 12, 0, 0]);
    return {
        start: center.clone().subtract(1, 'day').startOf('day').toDate(),
        end: center.clone().add(1, 'day').endOf('day').toDate()
    };
}

/**
 * Peso da presença aprovada por solicitação:
 * - Terça-feira: Integral = 2; Gi ou No-Gi = 1 cada.
 * - Demais dias: 1 por solicitação (Integral ou outro).
 */
function presencaPesoPorSolicitacao(requestDate, classType) {
    const ct = String(classType || '').trim();
    const ymd = presencaCivilYmdBrasil(requestDate);
    if (!ymd) {
        return 1;
    }
    const dow = civilDateWeekdaySun0FromYmd(ymd);
    if (dow === null) {
        return 1;
    }
    const isTuesday = dow === 2;
    if (isTuesday) {
        if (ct === 'Integral') {
            return 2;
        }
        return 1;
    }
    return 1;
}

function normalizeDateOnlyToStart(dateOnlyIso) {
    // dateOnlyIso: YYYY-MM-DD
    return new Date(`${dateOnlyIso}T00:00:00`);
}

function normalizeDateOnlyToEnd(dateOnlyIso) {
    // dateOnlyIso: YYYY-MM-DD
    return new Date(`${dateOnlyIso}T23:59:59.999`);
}

/**
 * Soma o peso das presenças aprovadas dentro de um período e de um conjunto de turmas.
 * Com `userCode` retorna um número (uso "aluno único": dashboard/modal). Sem `userCode`
 * (uso em lote: relatório de presenças) retorna um Map<user_code, number>.
 */
async function computeWeightedApprovedCount({ userCode = null, userCodes = null, classCodes, startAt, endAt }) {
    if (!Array.isArray(classCodes) || classCodes.length === 0) {
        return userCode ? 0 : new Map();
    }

    const where = {
        status: 'A',
        class_code: { [Op.in]: classCodes },
        request_date: { [Op.between]: [startAt, endAt] }
    };
    if (userCode) {
        where.user_code = userCode;
    } else if (Array.isArray(userCodes) && userCodes.length > 0) {
        where.user_code = { [Op.in]: userCodes };
    }

    const rows = await Presenca.findAll({ where, attributes: ['user_code', 'request_date', 'class_type'] });

    if (userCode) {
        return rows.reduce((sum, row) => sum + presencaPesoPorSolicitacao(row.request_date, row.class_type), 0);
    }

    const map = new Map();
    rows.forEach((row) => {
        const uc = String(row.user_code);
        map.set(uc, (map.get(uc) || 0) + presencaPesoPorSolicitacao(row.request_date, row.class_type));
    });
    return map;
}

/**
 * Encontra a meta imediatamente anterior (mesma turma, já encerrada antes do início da
 * meta atual, com período de exame definido) cujas presenças aprovadas no período de
 * Exame viram crédito de carry-over para a meta atual. Propositalmente não encadeia mais
 * de um nível: olha só para a meta anterior, nunca para a "avó" dela.
 */
async function findPreviousMetaForCarryOver(metaAtualStartDateIso, metaAtualClassCodes, excludeMetaId) {
    if (!Array.isArray(metaAtualClassCodes) || metaAtualClassCodes.length === 0) {
        return null;
    }

    const metaAnterior = await MetaAula.findOne({
        where: {
            id: { [Op.ne]: excludeMetaId },
            end_date: { [Op.lt]: metaAtualStartDateIso },
            exam_start_date: { [Op.ne]: null },
            exam_end_date: { [Op.ne]: null }
        },
        include: [
            {
                model: Turma,
                as: 'turmas',
                through: { attributes: [] },
                where: { class_code: { [Op.in]: metaAtualClassCodes } },
                required: true
            }
        ],
        order: [['end_date', 'DESC'], ['id', 'DESC']]
    });

    if (!metaAnterior) {
        return null;
    }

    const metaAnteriorPlain = metaAnterior.get({ plain: true });
    const turmasComuns = [...new Set((metaAnteriorPlain.turmas || []).map((t) => t.class_code))]
        .filter((code) => metaAtualClassCodes.includes(code));

    if (turmasComuns.length === 0) {
        return null;
    }

    return { metaAnterior: metaAnteriorPlain, turmasComuns };
}

/** Calcula quantas presenças o aluno já tem na meta vigente e quantas faltam para atingir a meta. */
async function getCurrentMetaProgressForStudent(userCode, { referenceDate = new Date() } = {}) {
    const normalizedUserCode = String(userCode || '').trim().toUpperCase();
    if (!normalizedUserCode) {
        return {
            hasMeta: false,
            metaId: null,
            metaTitle: '',
            totalClasses: 0,
            minClasses: 0,
            approvedCount: 0,
            presencasNaMeta: 0,
            presencasCount: 0,
            startDate: null,
            endDate: null,
            percent: 0
        };
    }

    const turmasAluno = await TurmaAluno.findAll({
        where: { user_code: normalizedUserCode, active: 'Y' },
        attributes: ['class_code']
    });
    const classCodes = [...new Set(turmasAluno.map((t) => t.class_code))].filter(Boolean);
    if (classCodes.length === 0) {
        return {
            hasMeta: false,
            metaId: null,
            metaTitle: '',
            totalClasses: 0,
            minClasses: 0,
            approvedCount: 0,
            presencasNaMeta: 0,
            presencasCount: 0,
            startDate: null,
            endDate: null,
            percent: 0
        };
    }

    const todayIso = moment(referenceDate).startOf('day').format('YYYY-MM-DD');

    const metaAtual = await MetaAula.findOne({
        where: {
            status: 'A',
            start_date: { [Op.lte]: todayIso },
            end_date: { [Op.gte]: todayIso }
        },
        include: [
            {
                model: Turma,
                as: 'turmas',
                through: { attributes: [] },
                where: { class_code: { [Op.in]: classCodes } },
                required: true
            }
        ],
        order: [['start_date', 'DESC'], ['id', 'DESC']]
    });

    if (!metaAtual) {
        return {
            hasMeta: false,
            metaId: null,
            metaTitle: '',
            totalClasses: 0,
            minClasses: 0,
            approvedCount: 0,
            presencasNaMeta: 0,
            presencasCount: 0,
            startDate: null,
            endDate: null,
            percent: 0
        };
    }

    const metaPlain = metaAtual.get({ plain: true });
    const metaClassCodes = [...new Set((metaPlain.turmas || []).map((t) => t.class_code))].filter(Boolean);

    const startIso = metaPlain.start_date;
    const effectiveEndIso = moment.min(
        moment(todayIso, 'YYYY-MM-DD'),
        moment(metaPlain.end_date, 'YYYY-MM-DD')
    ).format('YYYY-MM-DD');

    const startAt = normalizeDateOnlyToStart(startIso);
    const endAt = normalizeDateOnlyToEnd(effectiveEndIso);

    let approvedCount = await computeWeightedApprovedCount({
        userCode: normalizedUserCode,
        classCodes: metaClassCodes,
        startAt,
        endAt
    });

    // Carry-over: presenças aprovadas no período de Exame da meta anterior (mesma turma)
    // viram crédito inicial da meta atual, uma vez que a meta anterior encerrou e zerou.
    const carryOver = await findPreviousMetaForCarryOver(metaPlain.start_date, metaClassCodes, metaPlain.id);
    if (carryOver) {
        const examStartAt = normalizeDateOnlyToStart(carryOver.metaAnterior.exam_start_date);
        const examEndAt = normalizeDateOnlyToEnd(carryOver.metaAnterior.exam_end_date);
        approvedCount += await computeWeightedApprovedCount({
            userCode: normalizedUserCode,
            classCodes: carryOver.turmasComuns,
            startAt: examStartAt,
            endAt: examEndAt
        });
    }

    const totalClasses = Number(metaPlain.total_classes) || 0;
    const minClasses = Number(metaPlain.min_classes) || 0;
    const percentRaw = totalClasses > 0 ? (approvedCount / totalClasses) * 100 : 0;
    const percent = Math.max(0, Math.min(100, Math.round(percentRaw)));
    const presencasNaMeta = Number(approvedCount) || 0;
    // Contagem simples (sem ponderação de terça/Integral), mas com o mesmo escopo de turma e período da meta vigente.
    const approvedRows = await Presenca.findAll({
        where: {
            user_code: normalizedUserCode,
            status: 'A',
            class_code: { [Op.in]: metaClassCodes },
            request_date: { [Op.between]: [startAt, endAt] }
        },
        attributes: ['id']
    });
    const presencasCount = approvedRows.length;

    return {
        hasMeta: true,
        metaId: metaPlain.id,
        metaTitle: metaPlain.title || '',
        totalClasses,
        minClasses,
        approvedCount: presencasNaMeta,
        presencasNaMeta,
        presencasCount,
        startDate: startIso,
        endDate: metaPlain.end_date,
        percent
    };
}

/** Monta os dados de uma presença para exibir na tela (data formatada, status legível, tipo de aula). */
function buildPresencaViewModel(p) {
    const plain = p.get ? p.get({ plain: true }) : p;
    const statusMap = { P: 'Pendente', A: 'Aprovada', N: 'Negada', C: 'Solicitação cancelada' };
    const statusClassMap = { P: 'text-warning', A: 'text-success', N: 'text-danger', C: 'text-secondary' };
    const classTypeDisplayMap = { Integral: 'Integral', Gi: 'Gi (1ª Aula)', 'No-Gi': 'No-Gi (2ª Aula)' };
    const ymd = presencaCivilYmdBrasil(plain.request_date) || moment(plain.request_date).format('YYYY-MM-DD');
    return {
        ...plain,
        request_date_formatted: moment(ymd, 'YYYY-MM-DD').format('DD/MM/YYYY'),
        request_date_ts: moment(plain.createdAt || plain.request_date).format('DD/MM/YYYY HH:mm:ss'),
        request_date_iso: ymd,
        status_label: statusMap[plain.status] || plain.status,
        status_class: statusClassMap[plain.status] || '',
        class_type_display: classTypeDisplayMap[plain.class_type] || plain.class_type
    };
}

/** Cria notificação in-app quando o professor aprova ou nega uma solicitação de presença. */
async function createPresencaDecisaoNotificacao(presencaInstance, decisao, { observation } = {}) {
    const vm = buildPresencaViewModel(presencaInstance);
    const dataLabel = vm.request_date_formatted;
    const aulaInfo = vm.class_type_display || vm.class_type;

    const destCode = normalizeUserCode(presencaInstance.user_code);
    if (!destCode) {
        return;
    }

    if (decisao === 'A') {
        await Notificacao.create({
            user_code: destCode,
            kind: 'PRESENCA_APROVADA',
            title: 'Solicitação de presença aprovada',
            body: `Sua solicitação de presença para ${dataLabel} (${aulaInfo}) foi aprovada.`,
            presenca_id: presencaInstance.id,
            read_at: null
        });
        return;
    }

    if (decisao === 'N') {
        const obs = observation ? String(observation).trim() : '';
        await Notificacao.create({
            user_code: destCode,
            kind: 'PRESENCA_NEGADA',
            title: 'Solicitação de presença negada',
            body: obs
                ? `Sua solicitação de presença para ${dataLabel} (${aulaInfo}) foi negada. Motivo informado pelo professor: ${obs}`
                : `Sua solicitação de presença para ${dataLabel} (${aulaInfo}) foi negada.`,
            presenca_id: presencaInstance.id,
            read_at: null
        });
    }
}

// =========================
// LOG DE ATIVIDADES (somente ADM)
// =========================
function normalizeAdminLogsPerPage(raw) {
    const n = parseInt(raw, 10);
    return [10, 20, 30, 50].includes(n) ? n : 10;
}

function buildAdminLogsQueryStringNoPage(f) {
    const params = new URLSearchParams();
    if (f.data_inicio) {
        params.set('data_inicio', f.data_inicio);
    }
    if (f.data_fim) {
        params.set('data_fim', f.data_fim);
    }
    if (f.status && f.status !== 'todos') {
        params.set('status', f.status);
    }
    if (f.user_code && f.user_code !== 'todos') {
        params.set('user_code', f.user_code);
    }
    if (f.per_page && f.per_page !== 10) {
        params.set('per_page', String(f.per_page));
    }
    return params.toString();
}

function buildAdminLogsUrl(filters) {
    const qs = buildAdminLogsQueryStringNoPage(filters);
    const page = filters.page && filters.page > 1 ? filters.page : null;
    const params = new URLSearchParams(qs);
    if (page) {
        params.set('page', String(page));
    }
    const tail = params.toString();
    return tail ? `/admin/logs?${tail}` : '/admin/logs';
}

app.get('/admin/logs', async (req, res) => {
    const forbidden = ensureAdminRoute(req, res);
    if (forbidden) {
        return forbidden;
    }

    const dataInicioRaw = String(req.query.data_inicio || '').trim();
    const dataFimRaw = String(req.query.data_fim || '').trim();
    const ymdRe = /^\d{4}-\d{2}-\d{2}$/;
    const data_inicio = ymdRe.test(dataInicioRaw) ? dataInicioRaw : '';
    const data_fim = ymdRe.test(dataFimRaw) ? dataFimRaw : '';

    const statusRaw = String(req.query.status || 'todos').toLowerCase();
    const status = ['todos', 'sucesso', 'falha'].includes(statusRaw) ? statusRaw : 'todos';

    const userCodeRaw = String(req.query.user_code || '').trim().toUpperCase();
    const user_code = userCodeRaw && userCodeRaw !== 'TODOS' ? userCodeRaw.substring(0, 5) : 'todos';

    const per_page = normalizeAdminLogsPerPage(req.query.per_page);
    const pageRaw = parseInt(req.query.page, 10);
    const currentPageRequested = Number.isInteger(pageRaw) && pageRaw > 0 ? pageRaw : 1;
    const pagesPerBlock = 8;

    const filterState = {
        data_inicio,
        data_fim,
        status,
        user_code,
        per_page,
        page: currentPageRequested
    };

    try {
        const where = {};
        const timeCond = {};
        if (data_inicio) {
            const d0 = toDateStartOfDay(data_inicio);
            if (d0) {
                timeCond[Op.gte] = d0;
            }
        }
        if (data_fim) {
            const d1 = toDateEndOfDay(data_fim);
            if (d1) {
                timeCond[Op.lte] = d1;
            }
        }
        if (Object.keys(timeCond).length > 0) {
            where.createdAt = timeCond;
        }
        if (status === 'sucesso') {
            where.status = 'SUCESSO';
        } else if (status === 'falha') {
            where.status = 'FALHA';
        }
        if (user_code !== 'todos') {
            where.user_code = user_code;
        }

        const totalItems = await AppActivityLog.count({ where });

        const paginationVm = buildPaginationVm(currentPageRequested, totalItems, per_page, pagesPerBlock);
        const offset = (paginationVm.currentPage - 1) * per_page;

        const rows = await AppActivityLog.findAll({
            where,
            order: [['id', 'DESC']],
            limit: per_page,
            offset,
            raw: true
        });

        const codesOnPage = [
            ...new Set(
                rows
                    .map((row) => String(row.user_code || '').trim().toUpperCase())
                    .filter((c) => c.length > 0)
            )
        ];
        const codesWithProfile = new Set();
        const codeToName = {};
        if (codesOnPage.length > 0) {
            const foundUsers = await Usuario.findAll({
                where: { user_code: { [Op.in]: codesOnPage } },
                attributes: ['user_code', 'first_name', 'last_name'],
                raw: true
            });
            foundUsers.forEach((u) => {
                const c = String(u.user_code || '').trim().toUpperCase();
                if (c) {
                    codesWithProfile.add(c);
                    const fullName = [u.first_name, u.last_name].filter(Boolean).join(' ').trim();
                    if (fullName) codeToName[c] = fullName;
                }
            });
        }

        const distinctRows = await sequelize.query(
            `SELECT DISTINCT user_code FROM tb_app_activity_logs
             WHERE user_code IS NOT NULL AND TRIM(user_code) <> ''
             ORDER BY user_code ASC`,
            { type: QueryTypes.SELECT }
        );
        const userCodesForFilter = distinctRows
            .map((r) => String(r.user_code || '').trim().toUpperCase())
            .filter(Boolean);

        let filterCodeToName = {};
        if (userCodesForFilter.length > 0) {
            const filterUsers = await Usuario.findAll({
                where: { user_code: { [Op.in]: userCodesForFilter } },
                attributes: ['user_code', 'first_name', 'last_name'],
                raw: true
            });
            filterUsers.forEach((u) => {
                const c = String(u.user_code || '').trim().toUpperCase();
                if (c) {
                    const fullName = [u.first_name, u.last_name].filter(Boolean).join(' ').trim();
                    if (fullName) filterCodeToName[c] = fullName;
                }
            });
        }

        const userFilterOptions = userCodesForFilter
            .map((code) => ({
                code,
                name: filterCodeToName[code] || null,
                selected: user_code !== 'todos' && user_code === code
            }))
            .sort((a, b) => {
                const nameA = a.name || a.code;
                const nameB = b.name || b.code;
                return nameA.localeCompare(nameB, 'pt-BR', { sensitivity: 'base' });
            });

        const filterForView = {
            ...filterState,
            statusTodos: status === 'todos',
            statusSucesso: status === 'sucesso',
            statusFalha: status === 'falha',
            userTodos: user_code === 'todos',
            per10: per_page === 10,
            per20: per_page === 20,
            per30: per_page === 30,
            per50: per_page === 50
        };

        const mkUrl = (pageNum) => buildAdminLogsUrl({ ...filterState, page: pageNum });

        const logs = rows.map((row) => {
            const at = row.created_at != null ? row.created_at : row.createdAt;
            const codeKey = row.user_code ? String(row.user_code).trim().toUpperCase() : '';
            const user_profile_href = codeKey && codesWithProfile.has(codeKey)
                ? `/admin/usuario/${encodeURIComponent(codeKey)}`
                : null;
            return {
                id: row.id,
                data_hora_label: at ? moment(at).format('DD/MM/YYYY HH:mm:ss') : '-',
                data_hora_label_short: at ? moment(at).format('DD/MM/YY HH:mm') : '-',
                user_code_label: row.user_code ? String(row.user_code).trim() : '—',
                user_profile_href,
                action: row.action,
                endpoint: row.endpoint,
                status: row.status,
                status_label: row.status === 'SUCESSO' ? 'SUCESSO' : 'FALHA',
                status_class: row.status === 'SUCESSO' ? 'text-success' : 'text-danger'
            };
        });

        const pagination = {
            currentPage: paginationVm.currentPage,
            totalPages: paginationVm.totalPages,
            totalItems: paginationVm.totalItems,
            hasPrev: paginationVm.hasPrev,
            hasNext: paginationVm.hasNext,
            prevPage: paginationVm.prevPage,
            nextPage: paginationVm.nextPage,
            pageNumbers: paginationVm.pageNumbers.map((pn) => ({
                number: pn.number,
                isCurrent: pn.isCurrent,
                href: mkUrl(pn.number)
            })),
            prevHref: mkUrl(paginationVm.prevPage),
            nextHref: mkUrl(paginationVm.nextPage),
            selectPages: Array.from({ length: paginationVm.totalPages }, (_u, i) => {
                const number = i + 1;
                return {
                    number,
                    isCurrent: number === paginationVm.currentPage,
                    href: mkUrl(number)
                };
            })
        };

        const logsQueryStringNoPage = buildAdminLogsQueryStringNoPage(filterState);

        return res.render('admin_logs', {
            logs,
            pagination,
            filter: filterForView,
            userFilterOptions,
            logsQueryStringNoPage,
            clearLogsUrl: '/admin/logs',
            logCleanupWarning: res.locals.adminLogCleanupWarning,
            mensagem: req.query.mensagem || '',
            tipoMensagem: req.query.tipo || 'info'
        });
    } catch (err) {
        const vm = getErrorViewModel(500);
        return res.status(500).render('errors/error', { ...vm, message: 'Erro ao carregar log de atividades: ' + err.message });
    }
});

app.post('/admin/logs/executar-limpeza', async (req, res) => {
    const forbidden = ensureAdminRoute(req, res);
    if (forbidden) {
        return forbidden;
    }

    try {
        await sequelize.query('TRUNCATE TABLE tb_app_activity_logs');
        const mensagem = 'Limpeza de log concluída. Todos os registros foram removidos.';
        return res.redirect(`/admin/logs?mensagem=${encodeURIComponent(mensagem)}&tipo=success`);
    } catch (err) {
        const mensagem = 'Erro ao executar limpeza de log: ' + err.message;
        return res.redirect(`/admin/logs?mensagem=${encodeURIComponent(mensagem)}&tipo=danger`);
    }
});

app.get('/admin/usuario/:user_code', async (req, res) => {
    const forbidden = ensureAdminRoute(req, res);
    if (forbidden) {
        return forbidden;
    }

    const user_code = String(req.params.user_code || '').trim().toUpperCase().substring(0, 5);
    if (!user_code) {
        const vm = getErrorViewModel(404);
        return res.status(404).render('errors/error', { ...vm, message: 'Código de usuário inválido.' });
    }

    try {
        const usuario = await Usuario.findOne({
            where: { user_code },
            attributes: {
                exclude: [
                    'password',
                    'reset_token_hash',
                    'reset_token_expires',
                    'email_change_token_hash',
                    'email_change_expires'
                ]
            },
            include: [
                {
                    model: Usuario,
                    as: 'responsavel',
                    attributes: ['user_code', 'first_name', 'last_name', 'email', 'phone', 'role'],
                    required: false
                }
            ]
        });

        if (!usuario) {
            const vm = getErrorViewModel(404);
            return res.status(404).render('errors/error', { ...vm, message: 'Usuário não encontrado para este código.' });
        }

        const plain = usuario.get({ plain: true });
        const beltDisplay = getBeltDisplayData(plain.actual_belt, plain.actual_degree);
        const birthParts = parseBirthDateParts(plain.birth_date);
        const birthYmd = birthParts ? buildYmdFromParts(birthParts) : '';
        const birth_date_br = birthYmd ? formatDateBrFromYmd(birthYmd) : '—';

        let turmaNome = '';
        if (plain.class_code) {
            const turma = await Turma.findByPk(String(plain.class_code).trim(), {
                attributes: ['class_name', 'class_code']
            });
            if (turma) {
                const t = turma.get({ plain: true });
                turmaNome = t.class_name || '';
            }
        }

        const photoUrl = plain.photo && String(plain.photo).trim()
            ? String(plain.photo).trim()
            : '/uploads/users/default.jpg';

        const responsavel = plain.responsavel
            ? {
                user_code: plain.responsavel.user_code,
                full_name: `${plain.responsavel.first_name || ''} ${plain.responsavel.last_name || ''}`.trim()
                    || plain.responsavel.user_code,
                email: plain.responsavel.email,
                phone_br: formatPhoneDigitsToBr(plain.responsavel.phone),
                role_label: roleLabelPtBr(plain.responsavel.role),
                profile_href: `/admin/usuario/${encodeURIComponent(String(plain.responsavel.user_code || '').trim().toUpperCase())}`
            }
            : null;

        const usuarioDetalhe = {
            user_code: plain.user_code,
            full_name: `${plain.first_name || ''} ${plain.last_name || ''}`.trim() || plain.user_code,
            email: plain.email,
            pending_email: plain.pending_email ? String(plain.pending_email).trim() : '',
            phone_br: formatPhoneDigitsToBr(plain.phone),
            birth_date_br,
            role_label: roleLabelPtBr(plain.role),
            user_status_label: userStatusLabelPtBr(plain.user_status),
            belt_summary_label: beltDisplay.summaryLabel,
            belt_image_path: beltDisplay.imagePath,
            wagi_label: getKimonoWagiZubonSizeLabel(plain.wagi_size),
            zubon_label: getKimonoWagiZubonSizeLabel(plain.zubon_size),
            obi_label: getObiSizeOptionLabel(plain.obi_size),
            class_display: plain.class_code
                ? (turmaNome ? `${plain.class_code} — ${turmaNome}` : String(plain.class_code))
                : '—',
            photo_url: photoUrl,
            responsavel,
            birthday_prefs_label: plain.birthday_messages_disabled
                ? `Mensagens de aniversário desativadas${
                    plain.birthday_messages_disabled_year != null
                        ? ` (ano ${plain.birthday_messages_disabled_year})`
                        : ''
                }`
                : 'Mensagens de aniversário ativas',
            conta_criada_label: plain.createdAt ? moment(plain.createdAt).format('DD/MM/YYYY HH:mm:ss') : '—'
        };

        return res.render('admin_usuario_detalhe', {
            usuario: usuarioDetalhe,
            voltarLogsUrl: '/admin/logs',
            pageTitle: 'Detalhes do cadastro'
        });
    } catch (err) {
        const vm = getErrorViewModel(500);
        return res.status(500).render('errors/error', { ...vm, message: 'Erro ao carregar cadastro: ' + err.message });
    }
});

// =========================
// RANKING (STD/PRO/ADM)
// =========================
app.get('/ranking', async (req, res) => {
    const forbidden = ensureRankingRoute(req, res);
    if (forbidden) return forbidden;

    return res.render('ranking', {
        pageTitle: 'Rankings internos'
    });
});

app.get('/ranking/dados', async (req, res) => {
    const forbidden = ensureRankingRoute(req, res);
    if (forbidden) {
        return res.status(403).json({ ok: false, mensagem: 'Acesso não permitido.' });
    }

    const pageRaw = parseInt(req.query.page, 10);
    const currentPage = Number.isInteger(pageRaw) && pageRaw > 0 ? pageRaw : 1;
    const itemsPerPage = 10;
    const pagesPerBlock = 8;

    try {
        const result = await buildFrequenciaRankingPage({
            currentPage,
            itemsPerPage,
            pagesPerBlock,
            beltMap: BELT_MAP,
            presencaPesoPorSolicitacao
        });

        return res.json({
            ok: true,
            items: result.items,
            pagination: {
                currentPage: result.pagination.currentPage,
                totalPages: result.pagination.totalPages,
                totalItems: result.pagination.totalItems,
                hasPrev: result.pagination.hasPrev,
                hasNext: result.pagination.hasNext,
                prevPage: result.pagination.prevPage,
                nextPage: result.pagination.nextPage,
                pageNumbers: result.pagination.pageNumbers
            },
            metaInfo: result.metaInfo
        });
    } catch (err) {
        return res.status(500).json({
            ok: false,
            mensagem: err.message || 'Erro ao carregar ranking de frequência.'
        });
    }
});

// =========================
// RELATÓRIOS (PRO/ADM)
// =========================
app.get('/relatorios', async (req, res) => {
    const forbidden = ensureProfessorRoute(req, res);
    if (forbidden) return forbidden;
    return res.render('relatorios');
});

app.get('/relatorios/nomes', async (req, res) => {
    const forbidden = ensureProfessorRoute(req, res);
    if (forbidden) return forbidden;

    try {
        const alunos = await fetchAllStudentsForReports();
        alunos.sort((a, b) => {
            const aActive = a.is_active ? 0 : 1;
            const bActive = b.is_active ? 0 : 1;
            if (aActive !== bActive) return aActive - bActive;
            return a.sort_key.localeCompare(b.sort_key);
        });
        return res.render('relatorios_nomes', { alunos });
    } catch (err) {
        const vm = getErrorViewModel(500);
        return res.status(500).render('errors/error', { ...vm, message: 'Erro ao carregar relatório: ' + err.message });
    }
});

app.get('/relatorios/nomes/download', async (req, res) => {
    const forbidden = ensureProfessorRoute(req, res);
    if (forbidden) return forbidden;

    const format = String(req.query.format || '').toLowerCase();
    if (!['pdf', 'xlsx'].includes(format)) {
        return res.status(400).send('Formato inválido.');
    }

    const datePrefix = getTodayYmd();
    const baseName = `${datePrefix}-Lista-de-Alunos-por-Nome.${format}`;

    const alunos = await fetchAllStudentsForReports();
    alunos.sort((a, b) => {
        const aActive = a.is_active ? 0 : 1;
        const bActive = b.is_active ? 0 : 1;
        if (aActive !== bActive) return aActive - bActive;
        return a.sort_key.localeCompare(b.sort_key);
    });

    if (format === 'xlsx') {
        return exportStudentsToXlsx(res, baseName, alunos.map((a) => ({
            nome: a.full_name,
            status: a.is_active ? 'Ativo' : 'Inativo',
            faixa: a.belt_label,
            grau: a.degree_label,
            aniversario: a.birth_date_br
        })), [
            { header: 'Nome completo', key: 'nome', width: 34 },
            { header: 'Status', key: 'status', width: 12 },
            { header: 'Faixa', key: 'faixa', width: 18 },
            { header: 'Grau', key: 'grau', width: 14 },
            { header: 'Aniversário', key: 'aniversario', width: 14 }
        ]);
    }

    return exportStudentsToPdf(res, baseName, 'Lista de alunos por nome', alunos, {
        includeAvatar: true,
        includeStatus: true,
        includeBelt: false
    });
});

/** Ordena alunos para o relatório de faixas: faixa mais graduada, graus, ordem alfabética e, por fim, data de nascimento (mais velho primeiro). */
function compareStudentsForBeltReport(a, b) {
    const groupDiff = b.belt_group_order_desc - a.belt_group_order_desc;
    if (groupDiff !== 0) return groupDiff;
    const degreeDiff = b.belt_degree_num - a.belt_degree_num;
    if (degreeDiff !== 0) return degreeDiff;
    const nameDiff = a.sort_key.localeCompare(b.sort_key);
    if (nameDiff !== 0) return nameDiff;
    return (a.birth_date_ymd || '9999-99-99').localeCompare(b.birth_date_ymd || '9999-99-99');
}

app.get('/relatorios/faixas', async (req, res) => {
    const forbidden = ensureProfessorRoute(req, res);
    if (forbidden) return forbidden;

    try {
        const alunos = await fetchAllStudentsForReports();
        alunos.sort(compareStudentsForBeltReport);

        alunos.forEach((a) => {
            const tam = String(a.obi_size || '').trim();
            a.belt_summary_label_with_size = tam ? `${a.belt_summary_label} (Tam. ${tam})` : a.belt_summary_label;
        });
        return res.render('relatorios_faixas', { alunos });
    } catch (err) {
        const vm = getErrorViewModel(500);
        return res.status(500).render('errors/error', { ...vm, message: 'Erro ao carregar relatório: ' + err.message });
    }
});

app.get('/relatorios/faixas/download', async (req, res) => {
    const forbidden = ensureProfessorRoute(req, res);
    if (forbidden) return forbidden;

    const format = String(req.query.format || '').toLowerCase();
    if (!['pdf', 'xlsx'].includes(format)) {
        return res.status(400).send('Formato inválido.');
    }

    const datePrefix = getTodayYmd();
    const baseName = `${datePrefix}-Lista-de-Faixas.${format}`;

    const alunos = await fetchAllStudentsForReports();
    alunos.sort(compareStudentsForBeltReport);

    if (format === 'xlsx') {
        return exportStudentsToXlsx(res, baseName, alunos.map((a) => ({
            nome: a.full_name,
            faixa_atual: a.belt_label,
            graus: a.degree_label,
            tamanho_faixa: a.obi_size || ''
        })), [
            { header: 'NOME COMPLETO', key: 'nome', width: 34 },
            { header: 'FAIXA ATUAL', key: 'faixa_atual', width: 18 },
            { header: 'GRAUS', key: 'graus', width: 14 },
            { header: 'TAMANHO DE FAIXA', key: 'tamanho_faixa', width: 18 }
        ]);
    }

    return exportStudentsToPdf(res, baseName, 'Lista de alunos por faixas', alunos, {
        includeAvatar: true,
        includeStatus: false,
        includeBelt: true,
        includeDegree: true,
        includeBeltSize: true,
        includeNameNote: false,
        uppercaseColumns: true,
        nameNoWrap: true,
        beltColWidth: 90,
        degreeColWidth: 60,
        beltSizeColWidth: 70,
        headerTitle: 'LISTA DE ALUNOS POR FAIXA',
        headerUppercaseTitle: true,
        headerTitleAlign: 'center',
        headerLinesAlign: 'center',
        headerLines: [
            `Data: ${formatDateBrFromYmd(getTodayYmd())}`,
            `Total de alunos: ${Array.isArray(alunos) ? alunos.length : 0}`
        ]
    });
});

async function fetchMetaOptionsForReport(selectedMetaId) {
    const metas = await MetaAula.findAll({
        attributes: ['id', 'title', 'start_date', 'end_date'],
        order: [['start_date', 'DESC'], ['id', 'DESC']]
    });
    return metas.map((m) => {
        const plain = m.get({ plain: true });
        const idStr = String(plain.id);
        return {
            ...plain,
            selected: selectedMetaId && idStr === String(selectedMetaId),
            start_date_br: formatDateBrFromYmd(plain.start_date),
            end_date_br: formatDateBrFromYmd(plain.end_date)
        };
    });
}

// Modo "Período específico": consulta livre por datas, deliberadamente bruta (sem peso,
// sem restrição de turma, sem carry-over) — mantida intacta, é outra ferramenta.
async function buildPresencasReportDataByRange(startYmd, endYmd) {
    const startDate = toDateStartOfDay(startYmd);
    const endDate = toDateEndOfDay(endYmd);
    if (!startDate || !endDate) {
        return { alunos: [], periodoLabel: '', hasPeriodo: false };
    }

    const countRows = await Presenca.findAll({
        attributes: [
            'user_code',
            [Sequelize.fn('COUNT', Sequelize.col('id')), 'presencas_count']
        ],
        where: {
            status: 'A',
            request_date: { [Op.between]: [startDate, endDate] }
        },
        group: ['user_code']
    });

    const countMap = countRows.reduce((acc, r) => {
        const plain = r.get({ plain: true });
        acc[String(plain.user_code)] = Number(plain.presencas_count) || 0;
        return acc;
    }, {});

    const alunos = await fetchAllStudentsForReports();
    alunos.forEach((a) => {
        a.presencas_count = countMap[String(a.user_code)] || 0;
    });
    alunos.sort((a, b) => (b.presencas_count - a.presencas_count) || a.sort_key.localeCompare(b.sort_key));

    return {
        alunos,
        hasPeriodo: true,
        periodoLabel: `${formatDateBrFromYmd(startYmd)} - ${formatDateBrFromYmd(endYmd)}`
    };
}

// Modo "Meta de aula": mesma regra usada no dashboard/modal (ponderada, restrita à turma
// da meta, com carry-over do período de Exame da meta anterior). Período completo da meta
// (start_date..end_date), sem capar em "hoje" — é consulta histórica/administrativa, não
// um progresso "ao vivo" de um único aluno.
async function buildPresencasReportDataByMeta(metaId) {
    const meta = await MetaAula.findByPk(metaId, {
        include: [{ model: Turma, as: 'turmas', through: { attributes: [] } }]
    });
    if (!meta) {
        return { alunos: [], hasPeriodo: false, periodoLabel: '' };
    }

    const metaPlain = meta.get({ plain: true });
    const metaClassCodes = [...new Set((metaPlain.turmas || []).map((t) => t.class_code))].filter(Boolean);

    const startAt = normalizeDateOnlyToStart(metaPlain.start_date);
    const endAt = normalizeDateOnlyToEnd(metaPlain.end_date);

    const mainCounts = await computeWeightedApprovedCount({ classCodes: metaClassCodes, startAt, endAt });

    let carryOverCounts = new Map();
    const carryOver = await findPreviousMetaForCarryOver(metaPlain.start_date, metaClassCodes, metaPlain.id);
    if (carryOver) {
        const examStartAt = normalizeDateOnlyToStart(carryOver.metaAnterior.exam_start_date);
        const examEndAt = normalizeDateOnlyToEnd(carryOver.metaAnterior.exam_end_date);
        carryOverCounts = await computeWeightedApprovedCount({
            classCodes: carryOver.turmasComuns,
            startAt: examStartAt,
            endAt: examEndAt
        });
    }

    const alunos = await fetchAllStudentsForReports();
    alunos.forEach((a) => {
        const uc = String(a.user_code);
        a.presencas_count = (mainCounts.get(uc) || 0) + (carryOverCounts.get(uc) || 0);
    });
    alunos.sort((a, b) => (b.presencas_count - a.presencas_count) || a.sort_key.localeCompare(b.sort_key));

    return {
        alunos,
        hasPeriodo: true,
        periodoLabel: `${formatDateBrFromYmd(metaPlain.start_date)} - ${formatDateBrFromYmd(metaPlain.end_date)}`
    };
}

app.get('/relatorios/presencas', async (req, res) => {
    const forbidden = ensureProfessorRoute(req, res);
    if (forbidden) return forbidden;

    try {
        const selectedMode = String(req.query.mode || '').toLowerCase() || '';
        const metaId = req.query.metaId ? String(req.query.metaId) : '';
        const selectedStart = req.query.start ? String(req.query.start) : '';
        const selectedEnd = req.query.end ? String(req.query.end) : '';

        const metas = await fetchMetaOptionsForReport(metaId);

        let downloadQuery = '';
        let report = { alunos: [], hasPeriodo: false, periodoLabel: '' };

        if (selectedMode === 'meta' && metaId) {
            report = await buildPresencasReportDataByMeta(metaId);
            if (report.hasPeriodo) {
                downloadQuery = `&mode=meta&metaId=${encodeURIComponent(metaId)}`;
            }
        } else if (selectedMode === 'range' && selectedStart && selectedEnd) {
            report = await buildPresencasReportDataByRange(selectedStart, selectedEnd);
            if (report.hasPeriodo) {
                downloadQuery = `&mode=range&start=${encodeURIComponent(selectedStart)}&end=${encodeURIComponent(selectedEnd)}`;
            }
        }

        return res.render('relatorios_presencas', {
            metas,
            selectedMode: selectedMode || 'meta',
            selectedStart,
            selectedEnd,
            hasPeriodo: report.hasPeriodo,
            periodoLabel: report.periodoLabel,
            alunos: report.alunos,
            alunosJSON: JSON.stringify(report.alunos || []),
            downloadQuery
        });
    } catch (err) {
        const vm = getErrorViewModel(500);
        return res.status(500).render('errors/error', { ...vm, message: 'Erro ao carregar relatório: ' + err.message });
    }
});

app.get('/relatorios/presencas/download', async (req, res) => {
    const forbidden = ensureProfessorRoute(req, res);
    if (forbidden) return forbidden;

    const format = String(req.query.format || '').toLowerCase();
    if (!['pdf', 'xlsx'].includes(format)) {
        return res.status(400).send('Formato inválido.');
    }

    const selectedMode = String(req.query.mode || '').toLowerCase();
    const metaId = req.query.metaId ? String(req.query.metaId) : '';
    const selectedStart = req.query.start ? String(req.query.start) : '';
    const selectedEnd = req.query.end ? String(req.query.end) : '';

    let report = { alunos: [], hasPeriodo: false, periodoLabel: '' };

    if (selectedMode === 'meta' && metaId) {
        report = await buildPresencasReportDataByMeta(metaId);
    } else if (selectedMode === 'range' && selectedStart && selectedEnd) {
        report = await buildPresencasReportDataByRange(selectedStart, selectedEnd);
    }

    if (!report.hasPeriodo) {
        return res.status(400).send('Período ausente.');
    }

    const alunos = report.alunos || [];

    const datePrefix = getTodayYmd();
    const baseName = `${datePrefix}-Lista-de-Presencas.${format}`;

    if (format === 'xlsx') {
        return exportStudentsToXlsx(res, baseName, alunos.map((a) => ({
            nome: a.full_name,
            presencas: a.presencas_count,
            faixa: a.belt_label,
            grau: a.degree_label
        })), [
            { header: 'Nome completo', key: 'nome', width: 34 },
            { header: 'Total', key: 'presencas', width: 12 },
            { header: 'Faixa', key: 'faixa', width: 18 },
            { header: 'Grau', key: 'grau', width: 14 }
        ]);
    }

    return exportStudentsToPdf(res, baseName, `Lista de presenças (${report.periodoLabel})`, alunos, {
        includeAvatar: true,
        includeStatus: false,
        includeBelt: false,
        includeTotal: true,
        headerTitle: 'QUANTIDADE DE PRESENCAS',
        headerUppercaseTitle: true,
        headerTitleAlign: 'center',
        headerLinesAlign: 'center',
        headerLines: [
            `Período: ${report.periodoLabel}`,
            `Total de alunos: ${Array.isArray(alunos) ? alunos.length : 0}`
        ]
    });
});

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

        try {
            await createPresencaDecisaoNotificacao(presenca, 'A');
        } catch (notifErr) {
            console.error('Erro ao registrar notificação de presença aprovada:', notifErr.message);
        }

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

        try {
            await createPresencaDecisaoNotificacao(presenca, 'N', { observation });
        } catch (notifErr) {
            console.error('Erro ao registrar notificação de presença negada:', notifErr.message);
        }

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

        const todayBrYmd = moment().utcOffset(PRESENCA_BR_UTC_OFFSET_MIN).format('YYYY-MM-DD');
        const limitBrYmd = moment()
            .utcOffset(PRESENCA_BR_UTC_OFFSET_MIN)
            .subtract(15, 'days')
            .format('YYYY-MM-DD');
        const results = [];
        const errors = [];

        for (const dateStr of dates) {
            if (!moment(dateStr, 'YYYY-MM-DD', true).isValid()) {
                errors.push({ date: dateStr, error: 'Data inválida.' });
                continue;
            }
            if (dateStr > todayBrYmd) {
                errors.push({ date: dateStr, error: 'Não é permitido solicitar para datas futuras.' });
                continue;
            }
            if (dateStr < limitBrYmd) {
                errors.push({
                    date: dateStr,
                    error: `Anterior ao limite de 15 dias (${moment(limitBrYmd, 'YYYY-MM-DD').format('DD/MM/YYYY')}).`
                });
                continue;
            }

            const range = presencaUtcRangeForYmd(dateStr);
            if (!range) {
                errors.push({ date: dateStr, error: 'Data inválida.' });
                continue;
            }

            const dupWindow = presencaDuplicateQueryRange(dateStr);
            const candidatosDup =
                dupWindow &&
                (await Presenca.findAll({
                    where: {
                        user_code: userCode,
                        request_date: { [Op.between]: [dupWindow.start, dupWindow.end] },
                        status: { [Op.ne]: 'C' }
                    },
                    attributes: ['id', 'request_date', 'class_type']
                }));
            const candidatosDoDia = (candidatosDup || []).filter((row) =>
                presencaMatchesSolicitacaoDay(row.request_date, dateStr)
            );

            const dayOfWeek = civilDateWeekdaySun0FromYmd(dateStr); // 0=Dom ... 2=Ter

            if (dayOfWeek !== 2) {
                if (candidatosDoDia.length > 0) {
                    errors.push({ date: dateStr, error: 'Já existe uma solicitação para este dia.' });
                    continue;
                }
                const presenca = await Presenca.create({
                    request_date: range.noon,
                    user_code: userCode,
                    status: 'P',
                    class_type: 'Integral',
                    class_code: selectedClassCode
                });
                results.push(buildPresencaViewModel(presenca));
                continue;
            }

            // Terça-feira: até 2 solicitações no mesmo dia, uma para cada aula (Gi e No-Gi).
            const ct = classTypes && classTypes[dateStr] ? classTypes[dateStr] : 'Integral';
            if (!['Integral', 'Gi', 'No-Gi'].includes(ct)) {
                errors.push({ date: dateStr, error: 'Tipo de aula inválido.' });
                continue;
            }
            const slotsRequested = ct === 'Integral' ? ['Gi', 'No-Gi'] : [ct];
            const slotsOcupados = new Set(candidatosDoDia.map((row) => row.class_type));

            for (const slot of slotsRequested) {
                if (slotsOcupados.has(slot)) {
                    errors.push({
                        date: dateStr,
                        error: `Já existe uma solicitação para a ${slot === 'Gi' ? '1ª aula' : '2ª aula'} nesse dia.`
                    });
                    continue;
                }
                const presenca = await Presenca.create({
                    request_date: range.noon,
                    user_code: userCode,
                    status: 'P',
                    class_type: slot,
                    class_code: selectedClassCode
                });
                results.push(buildPresencaViewModel(presenca));
            }
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

// =========================
// TROCAS DE AVATAR PENDENTES (PRO/ADM)
// =========================
app.get('/avatar-pendentes', async (req, res) => {
    const forbidden = ensureProfessorRoute(req, res);
    if (forbidden) return forbidden;

    try {
        const pendentes = await AvatarChangeRequest.findAll({
            order: [['createdAt', 'DESC']]
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

        const solicitacoes = pendentes.map((p) => {
            const plain = p.get({ plain: true });
            const aluno = usuarioMap[plain.user_code] || {
                fullName: plain.user_code,
                photo: '/uploads/users/default.jpg'
            };
            return {
                ...plain,
                aluno_nome: aluno.fullName,
                aluno_photo_atual: aluno.photo,
                aluno_photo_nova: `/uploads/users/${plain.temp_photo_filename}`,
                createdAtLabel: formatDateTimePtBr(plain.createdAt)
            };
        });

        return res.render('avatarpendentes', {
            mensagem: req.query.mensagem || '',
            tipoMensagem: req.query.tipo || 'danger',
            solicitacoes
        });
    } catch (err) {
        return res.render('avatarpendentes', {
            mensagem: 'Erro ao carregar solicitações: ' + err.message,
            tipoMensagem: 'danger',
            solicitacoes: []
        });
    }
});

app.post('/avatar-pendentes/:id/aprovar', async (req, res) => {
    if (!hasProfessorAccess(req.session.usuario)) {
        return res.json({ ok: false, mensagem: 'Apenas professor ou administrador pode aprovar solicitações.' });
    }

    try {
        const requestId = parseInt(req.params.id, 10);
        if (!Number.isInteger(requestId)) {
            throw new Error('ID inválido.');
        }

        const solicitacao = await AvatarChangeRequest.findByPk(requestId);
        if (!solicitacao) {
            throw new Error('Solicitação não encontrada.');
        }

        const usuario = await Usuario.findOne({ where: { user_code: solicitacao.user_code } });
        if (!usuario) {
            throw new Error('Aluno não encontrado.');
        }

        await replaceUserPhoto(usuario, solicitacao.temp_photo_filename);
        await solicitacao.destroy();

        try {
            await Notificacao.create({
                user_code: usuario.user_code,
                kind: 'AVATAR_APROVADO',
                title: 'Novo avatar aprovado',
                body: 'Sua nova foto de perfil foi analisada e aprovada pelo professor.',
                read_at: null
            });
        } catch (notifErr) {
            console.error('Erro ao registrar notificação de avatar aprovado:', notifErr.message);
        }

        return res.json({ ok: true, mensagem: 'Avatar aprovado com sucesso.' });
    } catch (err) {
        return res.json({ ok: false, mensagem: 'Erro ao aprovar solicitação: ' + err.message });
    }
});

app.post('/avatar-pendentes/:id/negar', async (req, res) => {
    if (!hasProfessorAccess(req.session.usuario)) {
        return res.json({ ok: false, mensagem: 'Apenas professor ou administrador pode negar solicitações.' });
    }

    try {
        const requestId = parseInt(req.params.id, 10);
        if (!Number.isInteger(requestId)) {
            throw new Error('ID inválido.');
        }

        const solicitacao = await AvatarChangeRequest.findByPk(requestId);
        if (!solicitacao) {
            throw new Error('Solicitação não encontrada.');
        }

        const tempFilePath = path.join(uploadsDir, solicitacao.temp_photo_filename);
        if (fs.existsSync(tempFilePath)) {
            await fs.promises.unlink(tempFilePath);
        }

        const userCode = solicitacao.user_code;
        await solicitacao.destroy();

        try {
            await Notificacao.create({
                user_code: userCode,
                kind: 'AVATAR_NEGADO',
                title: 'Novo avatar negado',
                body: 'Sua nova foto de perfil não foi aprovada pelo professor. Sua foto atual foi mantida.',
                read_at: null
            });
        } catch (notifErr) {
            console.error('Erro ao registrar notificação de avatar negado:', notifErr.message);
        }

        return res.json({ ok: true, mensagem: 'Solicitação negada com sucesso.' });
    } catch (err) {
        return res.json({ ok: false, mensagem: 'Erro ao negar solicitação: ' + err.message });
    }
});

app.get('/katas-movimentos', (req, res) => {
    const usuarioSessao = req.session.usuario;
    if (!usuarioSessao || usuarioSessao.role !== 'STD') {
        const mensagem = 'Apenas alunos podem acessar esta página.';
        return res.redirect(`/dashboard?mensagem=${encodeURIComponent(mensagem)}`);
    }

    return res.render('katas_movimentos', {
        katasJson: JSON.stringify(katasPorFaixaData)
    });
});

app.get('/notificacoes', async (req, res) => {
    const usuarioSessao = req.session.usuario;
    if (!usuarioSessao || usuarioSessao.role !== 'STD') {
        const mensagem = 'Apenas alunos podem acessar as notificações.';
        return res.redirect(`/dashboard?mensagem=${encodeURIComponent(mensagem)}`);
    }

    try {
        const rawCode = await getEffectiveUserCode(req);
        const codes = notificacaoRecipientCodes(rawCode);
        if (codes.length === 0) {
            const mensagem = 'Não foi possível identificar o aluno.';
            return res.redirect(`/dashboard?mensagem=${encodeURIComponent(mensagem)}`);
        }

        const rows = await Notificacao.findAll({
            where: { user_code: { [Op.in]: codes } },
            order: [['createdAt', 'DESC']],
            limit: 100
        });

        const notificacoes = rows.map((row) => {
            const plain = row.get({ plain: true });
            return {
                ...plain,
                createdAtLabel: formatDateTimePtBr(plain.createdAt),
                readAtLabel: plain.read_at ? formatDateTimePtBr(plain.read_at) : '',
                isUnread: !plain.read_at,
                kindBadge:
                    plain.kind === 'PRESENCA_NEGADA' || plain.kind === 'AVATAR_NEGADO'
                        ? 'danger'
                        : plain.kind === 'PRESENCA_APROVADA' || plain.kind === 'AVATAR_APROVADO'
                            ? 'success'
                            : 'secondary'
            };
        });

        return res.render('notificacoes', {
            mensagem: req.query.mensagem || '',
            tipoMensagem: req.query.tipo || 'info',
            notificacoes
        });
    } catch (err) {
        return res.render('notificacoes', {
            mensagem: 'Erro ao carregar notificações: ' + err.message,
            tipoMensagem: 'danger',
            notificacoes: []
        });
    }
});

app.post('/notificacoes/marcar-todas-lidas', async (req, res) => {
    const usuarioSessao = req.session.usuario;
    if (!usuarioSessao || usuarioSessao.role !== 'STD') {
        return res.status(403).json({ ok: false, mensagem: 'Acesso negado.' });
    }

    try {
        const codes = notificacaoRecipientCodes(await getEffectiveUserCode(req));
        if (codes.length === 0) {
            return res.status(400).json({ ok: false, mensagem: 'Aluno não identificado.' });
        }

        const now = new Date();
        await Notificacao.update(
            { read_at: now },
            { where: { user_code: { [Op.in]: codes }, read_at: null } }
        );

        return res.json({ ok: true });
    } catch (err) {
        return res.status(500).json({ ok: false, mensagem: err.message });
    }
});

app.post('/notificacoes/remover', async (req, res) => {
    const usuarioSessao = req.session.usuario;
    if (!usuarioSessao || usuarioSessao.role !== 'STD') {
        return res.status(403).json({ ok: false, mensagem: 'Acesso negado.' });
    }

    try {
        const rawIds = Array.isArray(req.body?.ids) ? req.body.ids : [];
        const ids = [...new Set(
            rawIds
                .map((value) => parseInt(value, 10))
                .filter((id) => Number.isInteger(id) && id > 0)
        )];

        if (ids.length === 0) {
            return res.status(400).json({ ok: false, mensagem: 'Selecione ao menos uma notificação.' });
        }

        const codes = notificacaoRecipientCodes(await getEffectiveUserCode(req));
        if (codes.length === 0) {
            return res.status(400).json({ ok: false, mensagem: 'Aluno não identificado.' });
        }

        const removedCount = await Notificacao.destroy({
            where: {
                id: { [Op.in]: ids },
                user_code: { [Op.in]: codes }
            }
        });

        if (removedCount === 0) {
            return res.status(404).json({ ok: false, mensagem: 'Nenhuma notificação encontrada para remover.' });
        }

        const mensagem = removedCount === 1
            ? '1 notificação removida com sucesso.'
            : `${removedCount} notificações removidas com sucesso.`;

        return res.json({ ok: true, removedCount, mensagem });
    } catch (err) {
        return res.status(500).json({ ok: false, mensagem: err.message });
    }
});

app.post('/notificacoes/:id/ler', async (req, res) => {
    const usuarioSessao = req.session.usuario;
    if (!usuarioSessao || usuarioSessao.role !== 'STD') {
        return res.status(403).json({ ok: false, mensagem: 'Acesso negado.' });
    }

    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({ ok: false, mensagem: 'ID inválido.' });
        }

        const codes = notificacaoRecipientCodes(await getEffectiveUserCode(req));
        if (codes.length === 0) {
            return res.status(400).json({ ok: false, mensagem: 'Aluno não identificado.' });
        }

        const notif = await Notificacao.findOne({
            where: { id, user_code: { [Op.in]: codes } }
        });
        if (!notif) {
            return res.status(404).json({ ok: false, mensagem: 'Notificação não encontrada.' });
        }

        if (!notif.read_at) {
            notif.read_at = new Date();
            await notif.save();
        }

        return res.json({ ok: true });
    } catch (err) {
        return res.status(500).json({ ok: false, mensagem: err.message });
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

app.post('/mensagens/ocultar', async (req, res) => {
    try {
        const usuarioSessao = req.session.usuario;
        if (!usuarioSessao || !usuarioSessao.user_code) {
            return res.status(401).json({ ok: false, mensagem: 'Não autenticado.' });
        }

        const messageId = parseInt(req.body.message_id, 10);
        if (!Number.isInteger(messageId) || messageId <= 0) {
            return res.status(400).json({ ok: false, mensagem: 'Mensagem inválida.' });
        }

        const mensagem = await findVisibleMassMessageForStudent(usuarioSessao, messageId);
        if (!mensagem) {
            return res.status(403).json({ ok: false, mensagem: 'Sem turma ativa para esta operação.' });
        }

        await MensagemProfessorOcultacao.findOrCreate({
            where: {
                message_id: messageId,
                user_code: usuarioSessao.user_code
            },
            defaults: {
                hidden_at: new Date()
            }
        });

        const state = await getStudentMassMessageState(usuarioSessao);

        return res.json({
            ok: true,
            unreadCount: state.unreadCount,
            totalCount: state.totalCount
        });
    } catch (err) {
        return res.status(500).json({ ok: false, mensagem: 'Erro ao ocultar mensagem: ' + err.message });
    }
});

app.post('/mensagens/mestre/:id/lida', async (req, res) => {
    try {
        const usuarioSessao = req.session.usuario;
        if (!usuarioSessao || usuarioSessao.role !== 'STD' || !usuarioSessao.user_code) {
            return res.status(401).json({ ok: false, mensagem: 'Não autenticado.' });
        }

        const messageId = parseInt(req.params.id, 10);
        if (!Number.isInteger(messageId) || messageId <= 0) {
            return res.status(400).json({ ok: false, mensagem: 'Mensagem inválida.' });
        }

        const result = await markMassMessageAsRead(usuarioSessao, messageId);
        return res.json({ ok: true, unreadCount: result.unreadCount, readAtLabel: result.readAtLabel });
    } catch (err) {
        if (err.message === 'Mensagem não encontrada.') {
            return res.status(404).json({ ok: false, mensagem: err.message });
        }

        return res.status(500).json({ ok: false, mensagem: 'Erro ao registrar leitura: ' + err.message });
    }
});

app.post('/mensagens/mestre/:id/naoLida', async (req, res) => {
    try {
        const usuarioSessao = req.session.usuario;
        if (!usuarioSessao || usuarioSessao.role !== 'STD' || !usuarioSessao.user_code) {
            return res.status(401).json({ ok: false, mensagem: 'Não autenticado.' });
        }

        const messageId = parseInt(req.params.id, 10);
        if (!Number.isInteger(messageId) || messageId <= 0) {
            return res.status(400).json({ ok: false, mensagem: 'Mensagem inválida.' });
        }

        // Verify message exists and is accessible to student
        const message = await findVisibleMassMessageForStudent(usuarioSessao, messageId);
        if (!message) {
            return res.status(404).json({ ok: false, mensagem: 'Mensagem não encontrada.' });
        }

        // Delete read record to mark as unread
        await MensagemProfessorLeitura.destroy({
            where: {
                message_id: messageId,
                user_code: usuarioSessao.user_code
            }
        });

        // Get updated state
        const state = await getStudentMassMessageState(usuarioSessao);
        return res.json({ ok: true, unreadCount: state.unreadCount });
    } catch (err) {
        if (err.message === 'Mensagem não encontrada.') {
            return res.status(404).json({ ok: false, mensagem: err.message });
        }

        return res.status(500).json({ ok: false, mensagem: 'Erro ao marcar como não lida: ' + err.message });
    }
});


// ============================================================================
// MAPEAMENTO DE ATRIBUTOS
// ============================================================================

/** Calcula pontuação 0–100 para cada atributo e o overall rating. */
function calcularAtributos(avaliacoes) {
    const campos = ['forca', 'tecnica', 'resistencia', 'agilidade', 'ataque', 'defesa'];
    const n = avaliacoes.length;

    if (n === 0) {
        return { forca: 0, tecnica: 0, resistencia: 0, agilidade: 0, ataque: 0, defesa: 0, overall: 0 };
    }

    const scores = {};
    for (const campo of campos) {
        const soma = avaliacoes.reduce((acc, a) => acc + (parseInt(a[campo], 10) || 0), 0);
        scores[campo] = Math.round((soma / (n * 3)) * 100);
    }

    const somaTotal = campos.reduce((acc, c) => acc + scores[c], 0);
    scores.overall = Math.round(somaTotal / campos.length);

    return scores;
}

/** Ordenações disponíveis no selectbox da listagem de atributos. */
const ATRIBUTOS_SORT_MODES = ['overall', 'faixa', 'alfa_asc', 'alfa_desc', 'idade'];

/** Compara dois alunos usando a cadeia de critérios de desempate da ordenação escolhida. */
function compararAlunosAtributos(a, b, sortMode) {
    const overallDesc = () => b.overall - a.overall;
    const faixaDesc = () => b.belt_group_order_desc - a.belt_group_order_desc;
    const alfaAsc = () => a.sort_key.localeCompare(b.sort_key);
    const alfaDesc = () => b.sort_key.localeCompare(a.sort_key);
    const idadeDesc = () => b.idade - a.idade;
    const nascimentoAsc = () => a.birth_ymd.localeCompare(b.birth_ymd);

    const cadeiasPorModo = {
        overall: [overallDesc, faixaDesc, alfaAsc, idadeDesc, nascimentoAsc],
        faixa: [faixaDesc, overallDesc, alfaAsc, idadeDesc, nascimentoAsc],
        alfa_asc: [alfaAsc, overallDesc, faixaDesc, idadeDesc, nascimentoAsc],
        alfa_desc: [alfaDesc, overallDesc, faixaDesc, idadeDesc, nascimentoAsc],
        idade: [idadeDesc, nascimentoAsc, overallDesc, faixaDesc, alfaAsc]
    };

    const cadeia = cadeiasPorModo[sortMode] || cadeiasPorModo.overall;
    for (const criterio of cadeia) {
        const resultado = criterio();
        if (resultado !== 0) return resultado;
    }
    return 0;
}

/** Lista todos os alunos STD ativos com seus ratings. */
app.get('/atributos', async (req, res) => {
    const forbidden = ensureProfessorRoute(req, res);
    if (forbidden) return forbidden;

    const alunos = await Usuario.findAll({
        where: { role: 'STD', user_status: 'A' },
        order: [['first_name', 'ASC'], ['last_name', 'ASC']]
    });

    const avaliacoesPorAluno = await AtributoAvaliacao.findAll({
        where: { user_code: alunos.map(a => a.user_code) }
    });

    const mapaAvaliacoes = {};
    for (const av of avaliacoesPorAluno) {
        if (!mapaAvaliacoes[av.user_code]) mapaAvaliacoes[av.user_code] = [];
        mapaAvaliacoes[av.user_code].push(av);
    }

    const lista = alunos.map(aluno => {
        const avs = mapaAvaliacoes[aluno.user_code] || [];
        const scores = calcularAtributos(avs);
        const nome = `${aluno.first_name} ${aluno.last_name}`;
        const birthParts = parseBirthDateParts(aluno.birth_date);
        return {
            user_code: aluno.user_code,
            nome,
            foto: aluno.photo || '/uploads/users/default.jpg',
            faixaBadge: getBeltBadgeClass(aluno.actual_belt),
            totalAvaliacoes: avs.length,
            overall: scores.overall,
            forca: scores.forca,
            tecnica: scores.tecnica,
            resistencia: scores.resistencia,
            agilidade: scores.agilidade,
            ataque: scores.ataque,
            defesa: scores.defesa,
            sort_key: normalizeNameSortKey(nome),
            belt_group_order_desc: getBeltGroupOrderDesc(aluno.actual_belt),
            idade: calculateAgeFromBirthDateParts(birthParts),
            birth_ymd: buildYmdFromParts(birthParts) || '0000-00-00',
        };
    });

    const searchTerm = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const searchKey = normalizeNameSortKey(searchTerm);
    const listaFiltrada = searchKey ? lista.filter(item => item.sort_key.includes(searchKey)) : lista;

    const sortModeSolicitado = ATRIBUTOS_SORT_MODES.includes(req.query.sort) ? req.query.sort : '';
    const todosOverallZero = listaFiltrada.every(item => item.overall === 0);
    const sortMode = sortModeSolicitado || (todosOverallZero ? 'alfa_asc' : 'overall');

    listaFiltrada.sort((a, b) => compararAlunosAtributos(a, b, sortMode));

    return res.render('atributos', {
        titulo: 'Mapeamento de Atributos',
        lista: listaFiltrada,
        sortMode: sortModeSolicitado,
        searchTerm
    });
});

/** Perfil de atributos de um aluno específico. */
app.get('/atributos/aluno/:user_code', async (req, res) => {
    const forbidden = ensureProfessorRoute(req, res);
    if (forbidden) return forbidden;

    const userCode = normalizeUserCode(req.params.user_code);
    if (!userCode) return res.redirect('/atributos');

    const aluno = await Usuario.findOne({ where: { user_code: userCode, role: 'STD' } });
    if (!aluno) {
        const vm = getErrorViewModel(404);
        return res.status(404).render('errors/error', vm);
    }

    const avaliacoes = await AtributoAvaliacao.findAll({
        where: { user_code: userCode },
        order: [['evaluation_date', 'DESC']]
    });

    const scores = calcularAtributos(avaliacoes);
    const hoje = getTodayYmd();
    const jaAvaliouHoje = avaliacoes.some(a => a.evaluation_date === hoje);

    const historicoVm = avaliacoes.map(a => ({
        id: a.id,
        data: formatDateBrFromYmd(a.evaluation_date),
        forca: a.forca,
        tecnica: a.tecnica,
        resistencia: a.resistencia,
        agilidade: a.agilidade,
        ataque: a.ataque,
        defesa: a.defesa
    }));

    const atributosForm = [
        { campo: 'forca',      label: 'Força',       emoji: '💪', valor: scores.forca },
        { campo: 'tecnica',    label: 'Técnica',     emoji: '🥊', valor: scores.tecnica },
        { campo: 'resistencia',label: 'Resistência', emoji: '⏱️', valor: scores.resistencia },
        { campo: 'agilidade',  label: 'Agilidade',   emoji: '🏃', valor: scores.agilidade },
        { campo: 'ataque',     label: 'Ataque',      emoji: '🎯', valor: scores.ataque },
        { campo: 'defesa',     label: 'Defesa',      emoji: '🛡️', valor: scores.defesa }
    ];

    return res.render('atributos_aluno', {
        titulo: `Atributos — ${aluno.first_name} ${aluno.last_name}`,
        aluno: {
            user_code: aluno.user_code,
            nome: `${aluno.first_name} ${aluno.last_name}`,
            foto: aluno.photo || '/uploads/users/default.jpg',
            faixaBadge: getBeltBadgeClass(aluno.actual_belt)
        },
        scores,
        radarData: JSON.stringify([scores.forca, scores.tecnica, scores.resistencia, scores.agilidade, scores.ataque, scores.defesa]),
        historico: historicoVm,
        jaAvaliouHoje,
        hoje,
        atributosForm
    });
});

/** Registra ou atualiza avaliação do dia para um aluno. */
app.post('/atributos/avaliar', async (req, res) => {
    const forbidden = ensureProfessorRoute(req, res);
    if (forbidden) return forbidden;

    const usuarioSessao = req.session.usuario;
    const { user_code, forca, tecnica, resistencia, agilidade, ataque, defesa } = req.body;

    const userCode = normalizeUserCode(user_code);
    if (!userCode) return res.status(400).json({ ok: false, mensagem: 'Aluno inválido.' });

    const parseAttr = (v) => {
        const n = parseInt(v, 10);
        if (!Number.isInteger(n) || n < 0 || n > 3) return null;
        return n;
    };

    const attrs = {
        forca: parseAttr(forca),
        tecnica: parseAttr(tecnica),
        resistencia: parseAttr(resistencia),
        agilidade: parseAttr(agilidade),
        ataque: parseAttr(ataque),
        defesa: parseAttr(defesa)
    };

    if (Object.values(attrs).some(v => v === null)) {
        return res.status(400).json({ ok: false, mensagem: 'Valores inválidos. Cada atributo deve ser entre 0 e 3.' });
    }

    const aluno = await Usuario.findOne({ where: { user_code: userCode, role: 'STD' } });
    if (!aluno) return res.status(404).json({ ok: false, mensagem: 'Aluno não encontrado.' });

    const hoje = getTodayYmd();

    const jaExiste = await AtributoAvaliacao.findOne({ where: { user_code: userCode, evaluation_date: hoje } });
    if (jaExiste) {
        return res.status(409).json({ ok: false, mensagem: 'Este aluno já foi avaliado hoje. Exclua a avaliação existente para registrar uma nova.' });
    }

    const registro = await AtributoAvaliacao.create({
        user_code: userCode,
        evaluation_date: hoje,
        ...attrs,
        evaluated_by: usuarioSessao.user_code
    });

    return res.json({ ok: true, id: registro.id });
});

/** Remove uma avaliação pelo ID. */
app.delete('/atributos/avaliar/:id', async (req, res) => {
    const forbidden = ensureProfessorRoute(req, res);
    if (forbidden) return forbidden;

    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ ok: false, mensagem: 'ID inválido.' });
    }

    const deletados = await AtributoAvaliacao.destroy({ where: { id } });
    if (deletados === 0) {
        return res.status(404).json({ ok: false, mensagem: 'Avaliação não encontrada.' });
    }

    return res.json({ ok: true });
});

// ============================================================================
// FAQ
// ============================================================================

app.get('/faq', (req, res) => {
    res.render('faq', {
        pageTitle: 'Perguntas Frequentes',
        metaTitle: 'FAQ | CRTN Belém',
        metaDescription: 'Perguntas frequentes sobre cadastro, login, recuperação de senha e uso do sistema CRTN Belém.',
        metaUrl: `${req.protocol}://${req.get('host')}${req.originalUrl}`,
        metaImage: '/img/logotipo.ico',
        metaRobots: 'index,follow'
    });
});

// ============================================================================
// CONTATO — formulário de contato com envio por e-mail
// ============================================================================

const _multer = require('multer');
const multerContact = _multer({ storage: _multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.get('/contato', (req, res) => {
    res.render('contato', {
        pageTitle: 'Fale Conosco',
        metaTitle: 'Contato | CRTN Belém',
        metaDescription: 'Fale conosco sobre cadastro, acesso, dúvidas ou suporte da plataforma CRTN Belém.',
        metaUrl: `${req.protocol}://${req.get('host')}${req.originalUrl}`,
        metaImage: '/img/logotipo.ico',
        metaRobots: 'index,follow'
    });
});

app.post('/contato', multerContact.single('arquivo'), async (req, res) => {
    const nome = String(req.body.nome || '').trim();
    const whatsapp = String(req.body.whatsapp || '').replace(/\D/g, '').slice(0, 11);
    const emailRemetente = normalizeEmail(req.body.email || '');
    const assunto = String(req.body.assunto || '').trim();
    const mensagemTexto = String(req.body.mensagem || '').trim();

    const camposObrigatorios = !nome || !whatsapp || !emailRemetente || !assunto || !mensagemTexto;
    if (camposObrigatorios) {
        return res.render('contato', {
            pageTitle: 'Fale Conosco',
            mensagem: 'Preencha todos os campos obrigatórios antes de enviar.',
            tipoMensagem: 'erro',
            metaTitle: 'Contato | CRTN Belém',
            metaDescription: 'Fale conosco sobre cadastro, acesso, dúvidas ou suporte da plataforma CRTN Belém.',
            metaUrl: `${req.protocol}://${req.get('host')}${req.originalUrl}`,
            metaImage: '/img/logotipo.ico',
            metaRobots: 'index,follow'
        });
    }

    const transportConfig = getPasswordResetTransportConfig();
    if (!transportConfig) {
        console.warn('[contato] SMTP não configurado — mensagem de contato não enviada.');
        return res.render('contato', {
            pageTitle: 'Fale Conosco',
            mensagem: 'O serviço de e-mail não está disponível no momento. Tente novamente mais tarde.',
            tipoMensagem: 'erro',
            metaTitle: 'Contato | CRTN Belém',
            metaDescription: 'Fale conosco sobre cadastro, acesso, dúvidas ou suporte da plataforma CRTN Belém.',
            metaUrl: `${req.protocol}://${req.get('host')}${req.originalUrl}`,
            metaImage: '/img/logotipo.ico',
            metaRobots: 'index,follow'
        });
    }

    try {
        const transporter = nodemailer.createTransport({
            ...transportConfig,
            connectionTimeout: 10000,
            greetingTimeout:   5000,
            socketTimeout:     10000
        });
        const from = process.env.SMTP_FROM || process.env.EMAIL_FROM || transportConfig.auth.user;

        const mailOptions = {
            from,
            to: 'codeonsoftwares@gmail.com',
            replyTo: emailRemetente,
            subject: `[Contato - Sistema Oss] ${assunto}`,
            text: [
                `Nome: ${nome}`,
                `WhatsApp: ${whatsapp}`,
                `E-mail: ${emailRemetente}`,
                `Assunto: ${assunto}`,
                '',
                'Mensagem:',
                mensagemTexto
            ].join('\n'),
            html: `
                <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #212529;">
                    <h2 style="margin-bottom: 16px;">Formulário de Contato — Sistema Oss</h2>
                    <table style="border-collapse: collapse; width: 100%; max-width: 560px;">
                        <tr><td style="padding: 4px 8px; font-weight: 600; width: 110px;">Nome</td><td style="padding: 4px 8px;">${nome}</td></tr>
                        <tr><td style="padding: 4px 8px; font-weight: 600;">WhatsApp</td><td style="padding: 4px 8px;">${whatsapp}</td></tr>
                        <tr><td style="padding: 4px 8px; font-weight: 600;">E-mail</td><td style="padding: 4px 8px;"><a href="mailto:${emailRemetente}">${emailRemetente}</a></td></tr>
                        <tr><td style="padding: 4px 8px; font-weight: 600;">Assunto</td><td style="padding: 4px 8px;">${assunto}</td></tr>
                    </table>
                    <hr style="margin: 16px 0;">
                    <p style="white-space: pre-line;">${mensagemTexto}</p>
                </div>
            `
        };

        if (req.file && req.file.buffer && req.file.originalname) {
            mailOptions.attachments = [{
                filename: req.file.originalname,
                content: req.file.buffer,
                contentType: req.file.mimetype
            }];
        }

        await transporter.sendMail(mailOptions);

        return res.render('contato', {
            pageTitle: 'Fale Conosco',
            mensagem: 'Mensagem enviada com sucesso! Entraremos em contato em breve.',
            tipoMensagem: 'sucesso',
            metaTitle: 'Contato | CRTN Belém',
            metaDescription: 'Fale conosco sobre cadastro, acesso, dúvidas ou suporte da plataforma CRTN Belém.',
            metaUrl: `${req.protocol}://${req.get('host')}${req.originalUrl}`,
            metaImage: '/img/logotipo.ico',
            metaRobots: 'index,follow'
        });
    } catch (err) {
        console.error('[contato] Erro ao enviar e-mail:', err.message);
        return res.render('contato', {
            pageTitle: 'Fale Conosco',
            mensagem: 'Ocorreu um erro ao enviar sua mensagem. Tente novamente em instantes.',
            tipoMensagem: 'erro',
            metaTitle: 'Contato | CRTN Belém',
            metaDescription: 'Fale conosco sobre cadastro, acesso, dúvidas ou suporte da plataforma CRTN Belém.',
            metaUrl: `${req.protocol}://${req.get('host')}${req.originalUrl}`,
            metaImage: '/img/logotipo.ico',
            metaRobots: 'index,follow'
        });
    }
});

registerAuthRoutes(app, { buildBirthdayLoginModalData });

app.use(createNotFoundMiddleware({ isProduction }));
app.use(createErrorMiddleware({ isProduction }));

const PORT = process.env.ENV_PORT || 3000;

if (require.main === module) {
    ensureTurmaSchema()
        .then(() => ensureUsuarioEmailNotUnique())
        .then(() => initializeIgnition())
        .then((needsSetup) => {
            app.listen(PORT, function () {
                console.clear();
                console.log('');
                console.log('🚀 Servidor funcionando...');
                console.log(`✨ Acesse http://localhost:${PORT} para ver o app.`);
                if (needsSetup) {
                    console.log(`Configuração inicial pendente: http://localhost:${PORT}/ignition`);
                }
            });
        })
        .catch((err) => {
            console.error('Falha ao inicializar o servidor:', err.message);
            process.exit(1);
        });
}

module.exports = app;
