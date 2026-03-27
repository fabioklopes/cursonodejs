const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const Sequelize = require('sequelize');

const dbConfig = {
    host: process.env.ENV_DB_HOST || process.env.DB_HOST,
    user: process.env.ENV_DB_USER || process.env.DB_USER,
    password: process.env.ENV_DB_PASSWORD || process.env.DB_PASSWORD,
    name: process.env.ENV_DB_NAME || process.env.DB_NAME,
    port: parseInt(process.env.ENV_DB_PORT || process.env.DB_PORT || '3306', 10),
    dialect: process.env.ENV_DB_DIALECT || process.env.DB_DIALECT
};

if (!dbConfig.dialect) {
    throw new Error('Configuração de banco inválida: defina ENV_DB_DIALECT (ou DB_DIALECT) no arquivo .env.');
}

// conexão com o banco de dados
const sequelize = new Sequelize(
    dbConfig.name,
    dbConfig.user,
    dbConfig.password,
    {
        host: dbConfig.host,
        port: dbConfig.port,
        dialect: dbConfig.dialect
    }
);

module.exports = {
    Sequelize,
    sequelize
};