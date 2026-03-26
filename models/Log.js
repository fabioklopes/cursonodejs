import db from './db.js';
const { sequelize, Sequelize } = db;

// tb_log
const Log = sequelize.define('tb_log', {
    user_code: Sequelize.STRING(5),
    email: Sequelize.STRING(255),
    description: Sequelize.STRING,
    status :{
        type: Sequelize.ENUM('SUCCESS', 'FAIL'),
    }
});

Log.associate = models => {
    Log.belongsTo(models.Usuario, {
        foreignKey: 'user_code',
        targetKey: 'user_code',
    }),
    Log.belongsTo(models.Usuario, {
        foreignKey: 'email',
        targetKey: 'email',
    });
};



/** 
 * Nota: Use com cuidado em produção, pois pode resultar em perda de dados.
 * Opções válidas:
 * - force: true - Apaga a tabela existente e cria uma nova (perda de dados).
 * - alter: true - Altera a tabela para corresponder ao modelo, sem apagar dados (recomendado para produção).
*/
// Log.sync({ alter: true });

export default Log;