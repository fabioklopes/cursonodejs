const casual = require('casual');
const argon2 = require('argon2');
const Usuario = require('../models/Usuario');
const generateCode = require('./usercode_generator');

const ROLES = ['ADM', 'PRO', 'STD'];
const BELTS = [
    'white',
    'gray_white', 'gray', 'gray_black',
    'yellow_white', 'yellow', 'yellow_black',
    'orange_white', 'orange', 'orange_black',
    'green_white', 'green', 'green_black',
    'blue', 'purple', 'brown', 'black'
];
const DEGREES = ['0', '1', '2', '3', '4', '5', '6'];
const UNIFORM_SIZES = ['A0', 'A1', 'A2', 'A3', 'M0', 'M1', 'M2', 'M3', 'F0', 'F1'];
const OBI_SIZES = ['P', 'M', 'G', 'GG'];
const STATUSES = ['P', 'A', 'C'];

function randomFrom(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

function randomPhone() {
    // Format: 2 digit DDD + 9 digits
    const ddd = String(Math.floor(Math.random() * 89) + 11);
    const number = String(Math.floor(Math.random() * 900000000) + 100000000);
    return ddd + number;
}

function randomBirthDate() {
    // Between 5 and 60 years ago
    const now = new Date();
    const minAge = 5 * 365 * 24 * 60 * 60 * 1000;
    const maxAge = 60 * 365 * 24 * 60 * 60 * 1000;
    const ts = now.getTime() - minAge - Math.random() * (maxAge - minAge);
    return new Date(ts).toISOString().split('T')[0];
}

async function createFakeUsers(quantity = 10) {
    const hashedPassword = await argon2.hash('senha123');

    const users = [];
    for (let i = 0; i < quantity; i++) {
        const first_name = casual.first_name;
        const last_name = casual.last_name;
        const email = `${first_name.toLowerCase()}.${last_name.toLowerCase()}${i}@${casual.domain}`;

        users.push({
            user_code:    generateCode(5),
            first_name,
            last_name,
            email,
            password:     hashedPassword,
            role:         randomFrom(ROLES),
            phone:        randomPhone(),
            birth_date:   randomBirthDate(),
            actual_belt:  randomFrom(BELTS),
            actual_degree: randomFrom(DEGREES),
            wagi_size:    randomFrom(UNIFORM_SIZES),
            zubon_size:   randomFrom(UNIFORM_SIZES),
            obi_size:     randomFrom(OBI_SIZES),
            photo:        '/uploads/users/default.jpg',
            responsible_id: null,
            user_status:  randomFrom(STATUSES),
        });
    }

    try {
        const created = await Usuario.bulkCreate(users, { ignoreDuplicates: true });
        console.log(`${created.length} usuário(s) criado(s) com sucesso.`);
    } catch (err) {
        console.error('Erro ao criar usuários:', err.message);
    } finally {
        process.exit();
    }
}

const quantity = parseInt(process.argv[2]) || 10;
createFakeUsers(quantity);
