const Sequelize = require('sequelize');

// conexão com o banco de dados
const sequelize = new Sequelize(
    'db_academia_v2', 
    'root', 
    '5tgb6yhn', 
    {
        host: '127.0.0.1',
        dialect: 'mysql'
    }
);


module.exports = {
    Sequelize: Sequelize,
    sequelize: sequelize
}