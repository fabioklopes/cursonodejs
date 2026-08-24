/**
 * Funções auxiliares puras — não acessam banco nem sessão.
 * Usadas em várias partes do sistema: datas, faixas, nomes, paginação.
 */

const path = require('path');
const fs = require('fs');

const PROJECT_ROOT = path.join(__dirname, '..');

/** Verifica se o usuário logado é professor ou administrador (mesmo nível de acesso). */
function hasProfessorAccess(usuarioSessao) {
    return !!usuarioSessao && ['PRO', 'ADM'].includes(usuarioSessao.role);
}

/** Monta números de página para listagens com blocos (ex.: 1-5, 6-10). */
function buildPaginationVm(currentPageRequested, totalItems, itemsPerPage, pagesPerBlock) {
    const totalPages = Math.max(1, Math.ceil(totalItems / itemsPerPage));
    const currentPage = Math.min(Math.max(1, currentPageRequested), totalPages);
    const startPage = Math.floor((currentPage - 1) / pagesPerBlock) * pagesPerBlock + 1;
    const endPage = Math.min(startPage + pagesPerBlock - 1, totalPages);
    const visiblePages = endPage - startPage + 1;
    const pageNumbers = Array.from({ length: visiblePages }, (_unused, index) => {
        const pageNumber = startPage + index;
        return { number: pageNumber, isCurrent: pageNumber === currentPage };
    });
    return {
        currentPage,
        totalPages,
        totalItems,
        hasPrev: currentPage > 1,
        hasNext: currentPage < totalPages,
        prevPage: currentPage > 1 ? currentPage - 1 : 1,
        nextPage: currentPage < totalPages ? currentPage + 1 : totalPages,
        pageNumbers
    };
}

/** Converte data YYYY-MM-DD para formato brasileiro DD/MM/YYYY. */
function formatDateBrFromYmd(ymd) {
    const normalized = String(ymd || '').trim();
    const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) {
        return '-';
    }
    return `${match[3]}/${match[2]}/${match[1]}`;
}

/** Retorna a data civil de hoje no formato YYYY-MM-DD, no fuso fixo de Brasília (UTC-3). */
function getTodayYmd() {
    const BR_UTC_OFFSET_MIN = -180;
    return new Date(Date.now() + BR_UTC_OFFSET_MIN * 60000).toISOString().slice(0, 10);
}

function toDateStartOfDay(ymd) {
    const match = String(ymd || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 0, 0, 0, 0);
}

function toDateEndOfDay(ymd) {
    const match = String(ymd || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 23, 59, 59, 999);
}

function normalizeNameSortKey(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();
}

function buildYmdFromParts(parts) {
    if (!parts || !Number.isInteger(parts.year) || !Number.isInteger(parts.month) || !Number.isInteger(parts.day)) {
        return '';
    }
    const mm = String(parts.month).padStart(2, '0');
    const dd = String(parts.day).padStart(2, '0');
    return `${parts.year}-${mm}-${dd}`;
}

/** Extrai a cor base da faixa (ex.: gray_black → gray) para CSS e ordenação. */
function getBaseBeltColor(actualBelt) {
    const belt = String(actualBelt || '').trim();
    if (!belt) return 'white';
    if (belt.startsWith('gray')) return 'gray';
    if (belt.startsWith('yellow')) return 'yellow';
    if (belt.startsWith('orange')) return 'orange';
    if (belt.startsWith('green')) return 'green';
    if (belt === 'blue') return 'blue';
    if (belt === 'purple') return 'purple';
    if (belt === 'brown') return 'brown';
    if (belt === 'black') return 'black';
    if (belt === 'red') return 'red';
    if (belt === 'white') return 'white';
    return 'white';
}

function getBeltGroupOrderDesc(actualBelt) {
    const base = getBaseBeltColor(actualBelt);
    const orderMap = {
        red: 10,
        black: 9,
        brown: 8,
        purple: 7,
        blue: 6,
        green: 5,
        orange: 4,
        yellow: 3,
        gray: 2,
        white: 1
    };
    return orderMap[base] || 1;
}

function getBeltBadgeClass(actualBelt) {
    const base = getBaseBeltColor(actualBelt);
    return `belt-badge-${base}`;
}

function resolveLocalUploadFile(photoPath) {
    const normalized = String(photoPath || '').trim();
    if (!normalized.startsWith('/uploads/')) {
        return null;
    }
    const abs = path.join(PROJECT_ROOT, normalized.replace(/^\//, ''));
    return fs.existsSync(abs) ? abs : null;
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

/** Verifica se dois nomes de turma são parecidos demais (evita duplicatas confusas). */
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

function formatDateTimeForInput(dateValue) {
    if (!dateValue) {
        return '';
    }

    const date = new Date(dateValue);
    if (Number.isNaN(date.getTime())) {
        return '';
    }

    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatDateTimePtBr(dateValue) {
    if (!dateValue) {
        return '-';
    }

    const date = new Date(dateValue);
    if (Number.isNaN(date.getTime())) {
        return '-';
    }

    return date.toLocaleString('pt-BR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function formatDateTimePtBrWithAs(dateValue) {
    return formatDateTimePtBr(dateValue).replace(',', ' às');
}

function parseDateTimeInput(value) {
    const normalized = String(value || '').trim();
    if (!normalized) {
        return null;
    }

    const date = new Date(normalized);
    return Number.isNaN(date.getTime()) ? null : date;
}

/** Normaliza e-mail: minúsculas e sem espaços nas pontas. */
function normalizeEmail(value) {
    return String(value || '').trim().toLowerCase();
}

const NAME_CONNECTIVES_LOWER = new Set(['do', 'dos', 'da', 'das', 'de', 'e']);

/** Formata nome de pessoa com primeira letra maiúscula em cada palavra. */
function normalizePersonName(value) {
    const text = String(value || '').trim().replace(/\s+/g, ' ');
    if (!text) {
        return '';
    }

    return text
        .split(' ')
        .map((word) => {
            const w = word.trim();
            if (!w) {
                return '';
            }

            const lower = w.toLocaleLowerCase('pt-BR');
            return lower.charAt(0).toLocaleUpperCase('pt-BR') + lower.slice(1);
        })
        .filter(Boolean)
        .join(' ');
}

function formatLastNameWithConnectives(value) {
    const text = String(value || '').trim().replace(/\s+/g, ' ');
    if (!text) {
        return '';
    }

    return text
        .split(' ')
        .map((word) => {
            const w = word.trim();
            if (!w) {
                return '';
            }

            const lower = w.toLocaleLowerCase('pt-BR');
            if (NAME_CONNECTIVES_LOWER.has(lower)) {
                return lower;
            }

            return lower.charAt(0).toLocaleUpperCase('pt-BR') + lower.slice(1);
        })
        .filter(Boolean)
        .join(' ');
}

function formatPhoneDigitsToBr(phone) {
    if (phone === null || phone === undefined || phone === '') {
        return '—';
    }
    const cleaned = String(phone).replace(/\D/g, '');
    const match = cleaned.match(/^(\d{2})(\d{5})(\d{4})$/);
    if (match) {
        return `(${match[1]}) ${match[2]}-${match[3]}`;
    }
    const s = String(phone).trim();
    return s || '—';
}

function roleLabelPtBr(role) {
    if (role === 'ADM') return 'Administrador';
    if (role === 'PRO') return 'Professor';
    if (role === 'STD') return 'Aluno';
    return String(role || '').trim() || '—';
}

function userStatusLabelPtBr(status) {
    if (status === 'P') return 'Pendente';
    if (status === 'A') return 'Ativo';
    if (status === 'C') return 'Cancelado';
    return String(status || '').trim() || '—';
}

module.exports = {
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
    NAME_CONNECTIVES_LOWER,
    normalizePersonName,
    formatLastNameWithConnectives,
    formatPhoneDigitsToBr,
    roleLabelPtBr,
    userStatusLabelPtBr
};
