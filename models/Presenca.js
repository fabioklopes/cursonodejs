const db = require('./db');

// tb_presenca
const Presenca = db.sequelize.define('tb_presenca', {
    request_date: {
        type: db.Sequelize.DATE,
        allowNull: false,
        defaultValue: db.Sequelize.NOW
    },
    user_code: {
        type: db.Sequelize.STRING(5),
        allowNull: false
    },
    status: {
        type: db.Sequelize.ENUM('P', 'A', 'N', 'C'),
        allowNull: false,
        defaultValue: 'P'
    },
    class_type: {
        type: db.Sequelize.ENUM('Integral', 'Gi', 'No-Gi'),
        allowNull: false
    },
    class_id: db.Sequelize.INTEGER,
    observation: db.Sequelize.STRING,
    processed_by: db.Sequelize.STRING(5)
});


Presenca.associate = models => {
    if (!models || !models.Usuario) {
        return;
    }

    Presenca.belongsTo(models.Usuario, {
        as: 'aluno',
        foreignKey: 'user_code',
        targetKey: 'user_code'
    });

    Presenca.belongsTo(models.Usuario, {
        as: 'processadoPor',
        foreignKey: 'processed_by',
        targetKey: 'user_code'
    });
};


/** 
 * Nota: Use com cuidado em produção, pois pode resultar em perda de dados.
 * Opções válidas:
 * - force: true - Apaga a tabela existente e cria uma nova (perda de dados).
 * - alter: true - Altera a tabela para corresponder ao modelo, sem apagar dados (recomendado para produção).
*/
// Presenca.sync({ alter: true });

module.exports = Presenca;