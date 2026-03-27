const db = require('./db');

// tb_log
const Log = db.sequelize.define('tb_log', {
    user_code: db.Sequelize.STRING(5),
    email: db.Sequelize.STRING(255),
    description: db.Sequelize.STRING,
    status :{
        type: db.Sequelize.ENUM('SUCCESS', 'FAIL')
    }
});

Log.associate = models => {
    if (!models || !models.Usuario) {
        return;
    }

    Log.belongsTo(models.Usuario, {
        foreignKey: 'user_code',
        targetKey: 'user_code'
    });

    Log.belongsTo(models.Usuario, {
        foreignKey: 'email',
        targetKey: 'email'
    });
};



/** 
 * Nota: Use com cuidado em produção, pois pode resultar em perda de dados.
 * Opções válidas:
 * - force: true - Apaga a tabela existente e cria uma nova (perda de dados).
 * - alter: true - Altera a tabela para corresponder ao modelo, sem apagar dados (recomendado para produção).
*/
// Log.sync({ alter: true });

module.exports = Log;